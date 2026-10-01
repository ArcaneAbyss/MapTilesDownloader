$(function() {

	var map = null;
	var mapLoaded = false;
	var draw = null;
	var bar = null;

	var cancellationToken = null;

	// "running" while tiles download, "stitching" while the stitcher runs,
	// "finished" or "stopped" once the download sidebar can be closed
	var downloadState = null;

	var MIN_RADIUS = 1;
	var MAX_RADIUS = 50000;
	var AUTO_RATE_LIMIT_TILES = 2000;
	var MAX_TILE_ATTEMPTS = 3;
	var MIN_RATE = 0.5;
	var MIN_ZOOM = 1;
	var MAX_ZOOM = 18;
	var MAX_ZOOM_INTERVAL = MAX_ZOOM - MIN_ZOOM;
	var ZOOM_LIMITS_TEXT = "Zoom levels must be whole numbers from " + MIN_ZOOM + " to " + MAX_ZOOM + ", and Every from 1 to " + MAX_ZOOM_INTERVAL + ".";
	var MAX_PREVIEW_TILES = 10000;
	var LARGE_DOWNLOAD_TILES = 100000;
	var EST_KB_PER_TILE = 20;
	var MAX_LOG_LINES = 1000;
	var SETTINGS_KEY = "map-tiles-downloader-settings";
	var SETTINGS_VERSION = 2;
	var DEFAULT_OUTPUT_DIRECTORY = "{source}{variant}";

	var sourceGroups = [
		{
			label: "Bing",
			sources: {
				"Bing Maps": "http://ecn.t0.tiles.virtualearth.net/tiles/r{quad}.jpeg?g=129&mkt=en&stl=H",
				"Bing Maps Satellite": "http://ecn.t0.tiles.virtualearth.net/tiles/a{quad}.jpeg?g=129&mkt=en&stl=H",
				"Bing Maps Hybrid": "http://ecn.t0.tiles.virtualearth.net/tiles/h{quad}.jpeg?g=129&mkt=en&stl=H",
			}
		},
		{
			label: "Google",
			sources: {
				"Google Maps": "https://mt0.google.com/vt?lyrs=m&x={x}&s=&y={y}&z={z}",
				"Google Maps Satellite": "https://mt0.google.com/vt?lyrs=s&x={x}&s=&y={y}&z={z}",
				"Google Maps Hybrid": "https://mt0.google.com/vt?lyrs=h&x={x}&s=&y={y}&z={z}",
				"Google Maps Terrain": "https://mt0.google.com/vt?lyrs=p&x={x}&s=&y={y}&z={z}",
			}
		},
		{
			label: "OpenStreetMap",
			sources: {
				"Open Street Maps": "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
				"Open Cycle Maps": "http://a.tile.opencyclemap.org/cycle/{z}/{x}/{y}.png",
			}
		},
		{
			label: "Other",
			sources: {
				"ESRI World Imagery": "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
				"Sentinel-2 Cloudless (EOX)": "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg",
				"Carto Light": "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
			}
		},
	];

	// Settings

	var persistedInputs = [
		"#source-box",
		"#zoom-from-box",
		"#zoom-to-box",
		"#zoom-interval-box",
		"#output-type",
		"#output-scale",
		"#output-supersample",
		"#output-directory-box",
		"#output-file-box",
		"#parallel-threads-box",
		"#rate-limit-box",
		"#radius-box",
	];

	var persistedCheckboxes = [
		"#stitch-checkbox",
		"#source-preview-checkbox",
	];

	function loadSettings() {
		var settings = null;
		try {
			settings = JSON.parse(localStorage.getItem(SETTINGS_KEY));
		} catch(e) {}

		if(!settings) {
			return;
		}

		// Version 1 defaulted to a new {timestamp} folder per download; move those to per-source folders
		if((settings.version || 1) < 2 && settings["#output-directory-box"] === "{timestamp}") {
			delete settings["#output-directory-box"];
		}

		persistedInputs.forEach(function(id) {
			if(typeof settings[id] === "string") {
				$(id).val(settings[id]);
			}
		});

		persistedCheckboxes.forEach(function(id) {
			if(typeof settings[id] === "boolean") {
				$(id).prop("checked", settings[id]);
			}
		});

		// Settings saved before the interval field existed stepped zooms by the supersample setting
		if(typeof settings["#zoom-interval-box"] !== "string" && typeof settings["#output-supersample"] === "string") {
			$("#zoom-interval-box").val(intervalForSupersample(parseInt(settings["#output-supersample"], 10) || 1));
		}
	}

	function saveSettings() {
		var settings = { version: SETTINGS_VERSION };

		persistedInputs.forEach(function(id) {
			settings[id] = $(id).val();
		});

		persistedCheckboxes.forEach(function(id) {
			settings[id] = $(id).is(":checked");
		});

		try {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		} catch(e) {}
	}

	function initializeSettings() {
		loadSettings();
		$(persistedInputs.concat(persistedCheckboxes).join(",")).on("input change", saveSettings);
	}

	// Map

	function initializeMap() {

		map = new maplibregl.Map({
			container: 'map-view',
			style: {
				version: 8,
				sources: {
					'osm': {
						type: 'raster',
						tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
						tileSize: 256,
						attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
					}
				},
				layers: [{
					id: 'osm-tiles',
					type: 'raster',
					source: 'osm'
				}]
			},
			center: [103.8198, 1.3521],
			zoom: 12
		});

		map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

		map.on('load', function() {
			mapLoaded = true;

			map.addSource("corridor-preview", { type: "geojson", data: emptyCollection() });
			map.addLayer({
				'id': "corridor-preview-fill",
				'type': 'fill',
				'source': "corridor-preview",
				'paint': { "fill-color": "#00838f", "fill-opacity": 0.15 }
			});
			map.addLayer({
				'id': "corridor-preview-line",
				'type': 'line',
				'source': "corridor-preview",
				'paint': { "line-color": "#00838f", "line-width": 2, "line-dasharray": [2, 2] }
			});
			updateCorridorPreview();

			map.addLayer({
				'id': "active-tiles",
				'type': 'line',
				'source': {
					'type': 'geojson',
					'data': emptyCollection(),
				},
				'paint': {
					"line-color": "#ff9f1a",
					"line-width": 3,
				}
			});

			updateSourcePreview();
		});

		map.on('zoom', updateCurrentZoom);
		updateCurrentZoom();
	}

	function updateCurrentZoom() {
		$("#current-zoom").text(map.getZoom().toFixed(1));
	}

	function emptyCollection() {
		return { type: "FeatureCollection", features: [] };
	}

	function initializeMaterialize() {
		$('select').formSelect();
	}

	// Search, via OpenStreetMap Nominatim (no API key needed)

	function initializeSearch() {
		$("#search-form").submit(function(e) {
			e.preventDefault();

			var query = $("#location-box").val().trim();
			if(query == "") {
				return;
			}

			var button = $("#search-button");
			button.prop("disabled", true).text("...");

			$.ajax({
				url: "https://nominatim.openstreetmap.org/search",
				data: { format: "json", limit: 1, q: query },
				dataType: "json",
				timeout: 15 * 1000,
			}).done(function(results) {
				if(!results || results.length == 0) {
					M.toast({html: 'No place found for "' + escapeHtml(query) + '".', displayLength: 4000});
					return;
				}

				// boundingbox is [south, north, west, east]
				var box = results[0].boundingbox.map(parseFloat);
				map.fitBounds([[box[2], box[0]], [box[3], box[1]]], { padding: 40, maxZoom: 16 });
			}).fail(function() {
				M.toast({html: 'Search failed. Check your internet connection.', displayLength: 4000});
			}).always(function() {
				button.prop("disabled", false).text("Go");
			});
		});
	}

	function escapeHtml(text) {
		return $("<div>").text(text).html();
	}

	// Tile source

	function initializeSources() {

		var select = $("#source-select");

		sourceGroups.forEach(function(group) {
			var optgroup = $("<optgroup>").attr("label", group.label);
			for(var name in group.sources) {
				optgroup.append($("<option>").attr("value", group.sources[name]).text(name));
			}
			select.append(optgroup);
		});

		select.append($("<option>").attr("value", "custom").text("Custom URL"));

		select.change(function() {
			var url = select.val();
			if(url != "custom") {
				$("#source-box").val(url).trigger("change");
			} else {
				$("#source-box").focus().select();
			}
		});

		$("#source-box").on("input change", function() {
			syncSourceSelect();
			validateSource();
			scheduleSourcePreview();
		});

		$("#source-preview-checkbox").change(updateSourcePreview);

		syncSourceSelect();
		validateSource();
	}

	function syncSourceSelect() {
		var select = $("#source-select");
		var url = $("#source-box").val();
		var matched = select.find("option").filter(function() {
			return this.value == url;
		}).length > 0;

		var value = matched ? url : "custom";

		if(select.val() != value) {
			select.val(value);
			select.formSelect();
		}
	}

	function isValidSource(url) {
		var hasXYZ = url.indexOf("{x}") >= 0 && url.indexOf("{y}") >= 0 && url.indexOf("{z}") >= 0;
		var hasQuad = url.indexOf("{quad}") >= 0;
		return /^https?:\/\//.test(url) && (hasXYZ || hasQuad);
	}

	function validateSource() {
		var valid = isValidSource($("#source-box").val());
		$("#source-help")
			.toggleClass("error", !valid)
			.text(valid ? "Use {x}, {y}, {z} or {quad} as placeholders." : "URL must start with http(s):// and contain {x}, {y}, {z} or {quad}.");
		return valid;
	}

	var sourcePreviewTimer = null;

	function scheduleSourcePreview() {
		clearTimeout(sourcePreviewTimer);
		sourcePreviewTimer = setTimeout(updateSourcePreview, 500);
	}

	function updateSourcePreview() {
		if(!mapLoaded) {
			return;
		}

		removeLayer("source-preview");

		var url = $("#source-box").val();

		if(!$("#source-preview-checkbox").is(":checked") || !isValidSource(url)) {
			return;
		}

		// Draw the preview right above the base map, below the grid and the selection
		var layers = map.getStyle().layers;
		var beforeId = layers.length > 1 ? layers[1].id : undefined;

		map.addLayer({
			'id': "source-preview",
			'type': 'raster',
			'source': {
				'type': 'raster',
				'tiles': [url.replace("{quad}", "{quadkey}")],
				'tileSize': 256,
			},
		}, beforeId);
	}

	// Region selection: a rectangle, a free polygon, or a line with a radius (a corridor)

	var DRAW_MODES = {
		draw_rectangle: { button: "#rectangle-draw-button", hint: "Click two corners on the map to draw a rectangle." },
		draw_polygon: { button: "#polygon-draw-button", hint: "Click to add corners. Click the first corner or double-click to finish." },
		draw_line_string: { button: "#line-draw-button", hint: "Click to add points along the line, double-click to finish. Tiles within the radius of the line are downloaded." },
	};

	function initializeRegionTools() {

		// mapbox-gl-draw looks for mapboxgl-* class names; point it at MapLibre's
		var classes = MapboxDraw.constants.classes;
		classes.CANVAS = 'maplibregl-canvas';
		classes.CONTROL_BASE = 'maplibregl-ctrl';
		classes.CONTROL_PREFIX = 'maplibregl-ctrl-';
		classes.CONTROL_GROUP = 'maplibregl-ctrl-group';
		classes.ATTRIBUTION = 'maplibregl-ctrl-attrib';

		var modes = MapboxDraw.modes;
		modes.draw_rectangle = DrawRectangle.default;

		// The sidebar drives drawing, so the draw toolbar stays hidden
		draw = new MapboxDraw({
			modes: modes,
			displayControlsDefault: false,
		});
		map.addControl(draw);

		map.on('draw.create', function (e) {
			M.Toast.dismissAll();
			onRegionChanged();
		});

		map.on('draw.update', onRegionChanged);
		map.on('draw.delete', onRegionChanged);
		map.on('draw.modechange', updateRegionTools);

		$("#rectangle-draw-button").click(function() { startDrawing("draw_rectangle"); });
		$("#polygon-draw-button").click(function() { startDrawing("draw_polygon"); });
		$("#line-draw-button").click(function() { startDrawing("draw_line_string"); });
		$("#use-view-button").click(useCurrentView);

		$("#radius-box").on("input", onRegionChanged);
		$("#radius-box").on("change", function() {
			clampInput($(this), MIN_RADIUS, MAX_RADIUS);
		});
	}

	function startDrawing(mode) {
		removeGrid();
		draw.deleteAll();
		draw.changeMode(mode);
		onRegionChanged();

		M.Toast.dismissAll();
		M.toast({html: DRAW_MODES[mode].hint, displayLength: 7000})
	}

	// Highlight the tool being drawn with, and show the radius field for lines
	function updateRegionTools() {
		var mode = draw ? draw.getMode() : null;
		var region = getRegion();

		Object.keys(DRAW_MODES).forEach(function(key) {
			$(DRAW_MODES[key].button).toggleClass("active", mode == key);
		});

		$("#radius-field").toggle(mode == "draw_line_string" || (region != null && region.kind == "line"));
	}

	function useCurrentView() {
		var bounds = map.getBounds();
		var west = Math.max(bounds.getWest(), -180);
		var east = Math.min(bounds.getEast(), 180);
		var south = Math.max(bounds.getSouth(), -85.05);
		var north = Math.min(bounds.getNorth(), 85.05);

		draw.deleteAll();
		draw.add({
			type: "Feature",
			properties: {},
			geometry: {
				type: "Polygon",
				coordinates: [[[west, north], [east, north], [east, south], [west, south], [west, north]]],
			}
		});

		onRegionChanged();
	}

	function getRadius() {
		var value = parseFloat($("#radius-box").val());
		if(isNaN(value) || value < MIN_RADIUS || value > MAX_RADIUS) {
			return null;
		}
		return value;
	}

	function getRegion() {
		if(!draw) {
			return null;
		}

		var feature = draw.getAll().features[0];
		if(!feature) {
			return null;
		}

		// While a shape is being drawn, draw holds it unfinished; it counts once it has an extent
		if(feature.geometry.type == "LineString") {
			var line = feature.geometry.coordinates;
			var radius = getRadius();
			if(line.length < 2 || radius === null || lineLengthKm(line) == 0) {
				return null;
			}

			return { kind: "line", feature: feature, line: line, radius: radius, bounds: getCorridorBounds(line, radius), isRectangle: false };
		}

		if(feature.geometry.type == "Polygon") {
			if(feature.geometry.coordinates[0].length < 4) {
				return null;
			}

			var bounds = getBounds(feature.geometry.coordinates[0]);
			if(bounds.getWest() == bounds.getEast() || bounds.getSouth() == bounds.getNorth()) {
				return null;
			}

			return { kind: "polygon", feature: feature, bounds: bounds, isRectangle: isRectangle(feature, bounds) };
		}

		return null;
	}

	function getBounds(coordinates) {
		return coordinates.reduce(function(bounds, coord) {
			return bounds.extend(coord);
		}, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
	}

	// The line's bounding box widened by the radius
	function getCorridorBounds(line, radius) {
		var bounds = getBounds(line);
		var maxLat = Math.min(Math.max(Math.abs(bounds.getSouth()), Math.abs(bounds.getNorth())), 85);
		var latPad = radius / 111320;
		var lngPad = radius / (111320 * Math.cos(maxLat * Math.PI / 180));

		return new maplibregl.LngLatBounds(
			[Math.max(bounds.getWest() - lngPad, -180), Math.max(bounds.getSouth() - latPad, -85.05)],
			[Math.min(bounds.getEast() + lngPad, 180), Math.min(bounds.getNorth() + latPad, 85.05)]
		);
	}

	// An axis-aligned rectangle covers every tile in its bounding box, so the
	// per-tile intersection test can be skipped
	function isRectangle(feature, bounds) {
		var epsilon = 1e-9;
		var coordinates = feature.geometry.coordinates[0];

		if(coordinates.length != 5) {
			return false;
		}

		return coordinates.every(function(coord) {
			var onLng = Math.abs(coord[0] - bounds.getWest()) < epsilon || Math.abs(coord[0] - bounds.getEast()) < epsilon;
			var onLat = Math.abs(coord[1] - bounds.getSouth()) < epsilon || Math.abs(coord[1] - bounds.getNorth()) < epsilon;
			return onLng && onLat;
		});
	}

	function onRegionChanged() {
		removeGrid();
		updateRegionTools();
		updateCorridorPreview();
		updateRegionInfo();
		updateTileSummary();
	}

	// Shade the area around a line that will be downloaded
	function updateCorridorPreview() {
		var source = map.getSource("corridor-preview");
		if(!source) {
			return;
		}

		var region = getRegion();
		if(!region || region.kind != "line") {
			source.setData(emptyCollection());
			return;
		}

		source.setData(turf.buffer(turf.lineString(region.line), region.radius, { units: "meters", steps: 16 }));
	}

	function updateRegionInfo() {
		var region = getRegion();

		if(!region) {
			$("#region-info").text("No region selected yet.");
			return;
		}

		var bounds = region.bounds;
		var center = bounds.getCenter();
		var place = " around " + center.lat.toFixed(4) + ", " + center.lng.toFixed(4);

		if(region.kind == "line") {
			$("#region-info").html(
				"<b>" + formatKm(lineLengthKm(region.line)) + " line</b>, " + formatMeters(region.radius) + " either side," + place +
				"<br/>Click the line to move or reshape it, or draw again to replace it."
			);
			return;
		}

		var width = distanceKm(bounds.getWest(), center.lat, bounds.getEast(), center.lat);
		var height = distanceKm(center.lng, bounds.getSouth(), center.lng, bounds.getNorth());

		$("#region-info").html(
			(region.isRectangle ? "" : "Polygon spanning ") + "<b>" + formatKm(width) + " × " + formatKm(height) + "</b>" + place +
			"<br/>Click it to move or reshape it, or draw again to replace it."
		);
	}

	function lineLengthKm(line) {
		var total = 0;
		for(var i = 1; i < line.length; i++) {
			total += distanceKm(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
		}
		return total;
	}

	function formatMeters(meters) {
		return meters >= 1000 ? (meters / 1000).toLocaleString() + " km" : Math.round(meters) + " m";
	}

	function distanceKm(lng1, lat1, lng2, lat2) {
		var toRad = Math.PI / 180;
		var dLat = (lat2 - lat1) * toRad;
		var dLng = (lng2 - lng1) * toRad;
		var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
			Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
		return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	}

	function formatKm(km) {
		return km < 10 ? km.toFixed(2) + " km" : Math.round(km).toLocaleString() + " km";
	}

	// Zoom levels

	function initializeZoom() {
		$("#zoom-from-box, #zoom-to-box, #zoom-interval-box").on("input change", function() {
			removeGrid();
			updateTileSummary();
		});

		// Snap out-of-range values back into range once the field is left
		$("#zoom-from-box, #zoom-to-box").on("change", function() {
			clampInput($(this), MIN_ZOOM, MAX_ZOOM);
		});
		$("#zoom-interval-box").on("change", function() {
			clampInput($(this), 1, MAX_ZOOM_INTERVAL);
		});

		// Saved settings may predate the current limits
		$("#zoom-from-box, #zoom-to-box, #zoom-interval-box").trigger("change");
	}

	function clampInput(input, min, max) {
		var value = parseInt(input.val(), 10);
		if(isNaN(value)) {
			return;
		}

		var clamped = Math.min(Math.max(value, min), max);
		if(clamped !== value || String(clamped) !== input.val()) {
			input.val(clamped).trigger("input");
		}
	}

	function parseZoom(id) {
		var value = parseInt($(id).val(), 10);
		if(isNaN(value) || value < MIN_ZOOM || value > MAX_ZOOM) {
			return null;
		}
		return value;
	}

	function getZoomRange() {
		var from = parseZoom("#zoom-from-box");
		var to = parseZoom("#zoom-to-box");
		var step = getZoomInterval();

		if(from === null || to === null || step === null) {
			return null;
		}

		var min = Math.min(from, to);
		var max = Math.max(from, to);

		var levels = [];
		for(var z = min; z <= max; z += step) {
			levels.push(z);
		}

		// top is the deepest level actually downloaded, which can be below max when stepping
		return { min: min, max: max, step: step, levels: levels, top: levels[levels.length - 1] };
	}

	// Save every Nth zoom level, counting from the lower end of the range
	function getZoomInterval() {
		var value = parseInt($("#zoom-interval-box").val(), 10);
		if(isNaN(value) || value < 1 || value > MAX_ZOOM_INTERVAL) {
			return null;
		}
		return value;
	}

	// A supersampled tile already holds the detail of the next levels down (2x draws on zoom +1,
	// 4x on zoom +2), so the matching interval skips them: 2x every 2nd zoom, 4x every 3rd, 8x every 4th
	function intervalForSupersample(supersample) {
		return Math.log2(supersample) + 1;
	}

	// Tile math

	function long2tile(lon,zoom) {
		return (Math.floor((lon+180)/360*Math.pow(2,zoom)));
	}

	function lat2tile(lat,zoom)  {
		return (Math.floor((1-Math.log(Math.tan(lat*Math.PI/180) + 1/Math.cos(lat*Math.PI/180))/Math.PI)/2 *Math.pow(2,zoom)));
	}

	function tile2long(x,z) {
		return (x/Math.pow(2,z)*360-180);
	}

	function tile2lat(y,z) {
		var n=Math.PI-2*Math.PI*y/Math.pow(2,z);
		return (180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))));
	}

	function clampTile(value, zoom) {
		return Math.min(Math.max(value, 0), Math.pow(2, zoom) - 1);
	}

	function getTileRange(bounds, zoom) {
		return {
			top: clampTile(lat2tile(bounds.getNorth(), zoom), zoom),
			bottom: clampTile(lat2tile(bounds.getSouth(), zoom), zoom),
			left: clampTile(long2tile(bounds.getWest(), zoom), zoom),
			right: clampTile(long2tile(bounds.getEast(), zoom), zoom),
		};
	}

	function getTileRing(x, y, zoom) {
		var west = tile2long(x, zoom);
		var east = tile2long(x + 1, zoom);
		var north = tile2lat(y, zoom);
		var south = tile2lat(y + 1, zoom);

		return [[west, north], [east, north], [east, south], [west, south], [west, north]];
	}

	// Lines and polygons are resolved in tile coordinates (zoom z: the world is 2^z tiles across),
	// so the work grows with the tiles near the shape, not with its bounding box

	function tileX(lng, zoom) {
		return (lng + 180) / 360 * Math.pow(2, zoom);
	}

	function tileY(lat, zoom) {
		lat = Math.min(Math.max(lat, -85.0511), 85.0511) * Math.PI / 180;
		return (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * Math.pow(2, zoom);
	}

	// Width of one tile in metres on the ground at this latitude
	function metersPerTile(lat, zoom) {
		return 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
	}

	function pointSegmentDistance(px, py, ax, ay, bx, by) {
		var dx = bx - ax, dy = by - ay;
		var lengthSquared = dx * dx + dy * dy;
		var t = lengthSquared == 0 ? 0 : Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0), 1);
		return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
	}

	function pointBoxDistance(px, py, x0, y0, x1, y1) {
		return Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(y0 - py, 0, py - y1));
	}

	// Liang-Barsky clipping: does the segment pass through the box?
	function segmentHitsBox(ax, ay, bx, by, x0, y0, x1, y1) {
		var t0 = 0, t1 = 1;
		var dx = bx - ax, dy = by - ay;
		var p = [-dx, dx, -dy, dy];
		var q = [ax - x0, x1 - ax, ay - y0, y1 - ay];

		for(var i = 0; i < 4; i++) {
			if(p[i] == 0) {
				if(q[i] < 0) {
					return false;
				}
			} else {
				var t = q[i] / p[i];
				if(p[i] < 0) {
					t0 = Math.max(t0, t);
				} else {
					t1 = Math.min(t1, t);
				}
				if(t0 > t1) {
					return false;
				}
			}
		}
		return true;
	}

	// Exact distance between a segment and a box: zero if they cross, otherwise the
	// closest pair always involves an endpoint of the segment or a corner of the box
	function segmentBoxDistance(ax, ay, bx, by, x0, y0, x1, y1) {
		if(segmentHitsBox(ax, ay, bx, by, x0, y0, x1, y1)) {
			return 0;
		}

		return Math.min(
			pointBoxDistance(ax, ay, x0, y0, x1, y1),
			pointBoxDistance(bx, by, x0, y0, x1, y1),
			pointSegmentDistance(x0, y0, ax, ay, bx, by),
			pointSegmentDistance(x1, y0, ax, ay, bx, by),
			pointSegmentDistance(x0, y1, ax, ay, bx, by),
			pointSegmentDistance(x1, y1, ax, ay, bx, by)
		);
	}

	// Adds every tile within radiusMeters of the line through points ([lng, lat] pairs) to the map of tiles
	function addTilesNearLine(tiles, points, radiusMeters, zoom) {
		var size = Math.pow(2, zoom);

		for(var i = 1; i < points.length; i++) {
			var ax = tileX(points[i - 1][0], zoom), ay = tileY(points[i - 1][1], zoom);
			var bx = tileX(points[i][0], zoom), by = tileY(points[i][1], zoom);
			var r = radiusMeters / metersPerTile((points[i - 1][1] + points[i][1]) / 2, zoom);
			var dx = bx - ax, dy = by - ay;

			var firstRow = Math.max(Math.floor(Math.min(ay, by) - r), 0);
			var lastRow = Math.min(Math.floor(Math.max(ay, by) + r), size - 1);

			for(var y = firstRow; y <= lastRow; y++) {
				// Only the part of the segment within reach of this row can touch it
				var t0 = 0, t1 = 1;
				if(dy != 0) {
					var ta = (y - r - ay) / dy, tb = (y + 1 + r - ay) / dy;
					t0 = Math.max(Math.min(ta, tb), 0);
					t1 = Math.min(Math.max(ta, tb), 1);
					if(t0 > t1) {
						continue;
					}
				}

				var firstColumn = Math.max(Math.floor(Math.min(ax + t0 * dx, ax + t1 * dx) - r), 0);
				var lastColumn = Math.min(Math.floor(Math.max(ax + t0 * dx, ax + t1 * dx) + r), size - 1);

				for(var x = firstColumn; x <= lastColumn; x++) {
					if(segmentBoxDistance(ax, ay, bx, by, x, y, x + 1, y + 1) <= r) {
						tiles.set(y * size + x, { x: x, y: y, z: zoom });
					}
				}
			}
		}
	}

	// Adds every tile whose centre lies inside the polygon (even-odd across all rings, so holes work)
	function addTilesInsidePolygon(tiles, rings, zoom) {
		var size = Math.pow(2, zoom);
		var edges = [];
		var minY = Infinity, maxY = -Infinity;

		rings.forEach(function(ring) {
			for(var i = 1; i < ring.length; i++) {
				var edge = [tileX(ring[i - 1][0], zoom), tileY(ring[i - 1][1], zoom), tileX(ring[i][0], zoom), tileY(ring[i][1], zoom)];
				edges.push(edge);
				minY = Math.min(minY, edge[1], edge[3]);
				maxY = Math.max(maxY, edge[1], edge[3]);
			}
		});

		for(var y = Math.max(Math.floor(minY), 0); y <= Math.min(Math.floor(maxY), size - 1); y++) {
			var centerY = y + 0.5;
			var crossings = [];

			edges.forEach(function(e) {
				if((e[1] <= centerY) != (e[3] <= centerY)) {
					crossings.push(e[0] + (centerY - e[1]) / (e[3] - e[1]) * (e[2] - e[0]));
				}
			});

			crossings.sort(function(a, b) { return a - b; });

			for(var i = 0; i + 1 < crossings.length; i += 2) {
				var firstColumn = Math.max(Math.ceil(crossings[i] - 0.5), 0);
				var lastColumn = Math.min(Math.floor(crossings[i + 1] - 0.5), size - 1);
				for(var x = firstColumn; x <= lastColumn; x++) {
					tiles.set(y * size + x, { x: x, y: y, z: zoom });
				}
			}
		}
	}

	function getGrid(region, zoom) {

		if(region.kind == "line") {
			var corridor = new Map();
			addTilesNearLine(corridor, region.line, region.radius, zoom);
			return Array.from(corridor.values());
		}

		if(!region.isRectangle) {
			// A tile overlaps a polygon if the outline passes through it or its centre is inside
			var rings = region.feature.geometry.coordinates;
			var polygon = new Map();
			rings.forEach(function(ring) {
				addTilesNearLine(polygon, ring, 0, zoom);
			});
			addTilesInsidePolygon(polygon, rings, zoom);
			return Array.from(polygon.values());
		}

		var range = getTileRange(region.bounds, zoom);
		var tiles = [];

		for(var y = range.top; y <= range.bottom; y++) {
			for(var x = range.left; x <= range.right; x++) {
				tiles.push({ x: x, y: y, z: zoom });
			}
		}

		return tiles;
	}

	function countTiles(region, zoom) {
		if(!region.isRectangle) {
			return getGrid(region, zoom).length;
		}

		var range = getTileRange(region.bounds, zoom);
		return (range.right - range.left + 1) * (range.bottom - range.top + 1);
	}

	function getAllGridTiles(region, zoomRange) {
		var allTiles = [];

		zoomRange.levels.forEach(function(z) {
			allTiles = allTiles.concat(getGrid(region, z));
		});

		return allTiles;
	}

	function generateQuadKey(x, y, z) {
	    var quadKey = [];
	    for (var i = z; i > 0; i--) {
	        var digit = '0';
	        var mask = 1 << (i - 1);
	        if ((x & mask) != 0) {
	            digit++;
	        }
	        if ((y & mask) != 0) {
	            digit++;
	            digit++;
	        }
	        quadKey.push(digit);
	    }
	    return quadKey.join('');
	}

	// Tile count summary and the download button

	function updateTileSummary() {
		var summary = $("#tile-summary");
		var button = $("#download-button");
		var region = getRegion();
		var zoomRange = getZoomRange();

		summary.removeClass("warn");
		updateZoomStepHint(zoomRange);

		if(!zoomRange) {
			summary.text(ZOOM_LIMITS_TEXT);
			summary.addClass("warn");
			button.prop("disabled", true);
			return;
		}

		if(!region) {
			summary.text("Draw a region to see how many tiles it covers.");
			button.prop("disabled", true);
			return;
		}

		var total = 0;
		zoomRange.levels.forEach(function(z) {
			total += countTiles(region, z);
		});

		var scale = getOutputScale();
		var megabytes = total * EST_KB_PER_TILE * scale * scale / 1024;
		var requests = total * getRequestsPerTile();
		var html = "<b>" + total.toLocaleString() + "</b> tiles at " + formatZoomLevels(zoomRange.levels) +
			"<br/>Roughly " + formatMegabytes(megabytes) + " on disk";

		if(getSupersample() > 1) {
			var depth = getFetchDepth();
			html += "<br/>Built from " + formatZoomLevels(zoomRange.levels.map(function(z) { return z + depth; })) +
				" imagery, " + requests.toLocaleString() + " requests";
		}

		var rateLimit = getRateLimit(total);
		if(rateLimit) {
			html += "<br/>Paced at " + formatRate(rateLimit) + " requests/s, about " + formatDuration(requests / rateLimit);
		}

		summary.html(html);
		summary.toggleClass("warn", requests > LARGE_DOWNLOAD_TILES);
		button.prop("disabled", total == 0);
	}

	// Output folder

	function slugify(text) {
		return text.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
	}

	// Named after the provider picked in the list, or the host of a custom URL
	function getSourceSlug() {
		var option = $("#source-select option:selected");
		if(option.length && option.val() != "custom") {
			return slugify(option.text());
		}

		var host = $("#source-box").val().replace(/^https?:\/\//, "").split(/[\/?#]/)[0];
		return slugify(host) || "custom";
	}

	// Tiles made with a different scale or supersample must not share a folder with plain
	// tiles, or the "already downloaded" check would skip them
	function getVariant() {
		var variant = "";
		if(getOutputScale() > 1) {
			variant += "_" + (256 * getOutputScale()) + "px";
		}
		if(getSupersample() > 1) {
			variant += "_ss" + getSupersample() + "x";
		}
		return variant;
	}

	function resolveOutputDirectory() {
		return $("#output-directory-box").val()
			.split("{source}").join(getSourceSlug())
			.split("{variant}").join(getVariant());
	}

	function updateOutputPreview() {
		var directory = resolveOutputDirectory().split("{timestamp}").join("<timestamp>");
		$("#output-preview").text("→ output/" + directory + "/").attr("title", "output/" + directory + "/");
	}

	function initializeOutputPreview() {
		$("#source-box, #source-select, #output-scale, #output-supersample, #output-directory-box").on("input change", updateOutputPreview);
		updateOutputPreview();
	}

	// "zoom 15", "zoom 3–16" for consecutive levels, or "zoom 3, 6, 9" when stepping
	function formatZoomLevels(levels) {
		if(levels.length == 1) {
			return "zoom " + levels[0];
		}
		if(levels[1] - levels[0] == 1) {
			return "zoom " + levels[0] + "–" + levels[levels.length - 1];
		}
		if(levels.length > 6) {
			return "zoom " + levels.slice(0, 3).join(", ") + " … " + levels[levels.length - 1] + " (" + levels.length + " levels)";
		}
		return "zoom " + levels.join(", ");
	}

	function updateZoomStepHint(zoomRange) {
		var hint = $("#zoom-step-hint");
		if(!zoomRange || zoomRange.step == 1) {
			hint.hide();
			return;
		}

		var text = "Saving every " + ordinal(zoomRange.step) + " zoom: " + zoomRange.levels.join(", ");
		if(zoomRange.top != zoomRange.max) {
			text += " (zoom " + zoomRange.max + " is not on a step, so " + zoomRange.top + " is the deepest)";
		}
		hint.text(text).show();
	}

	function ordinal(n) {
		var suffix = (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
		return n + suffix;
	}

	// Conservative starting paces in requests/s for downloads above AUTO_RATE_LIMIT_TILES.
	// None of these providers publish a limit; the pace drops by itself if a server refuses.
	var PROVIDER_RATES = [
		{ pattern: /google\./, rate: 4 },
		{ pattern: /openstreetmap\.org|opencyclemap\.org/, rate: 2 },
		{ pattern: /virtualearth\.net/, rate: 10 },
		{ pattern: /arcgisonline\.com/, rate: 25 },
		{ pattern: /eox\.at/, rate: 10 },
		{ pattern: /cartocdn\.com/, rate: 10 },
	];
	var DEFAULT_PROVIDER_RATE = 8;

	function getProviderRate() {
		var host = $("#source-box").val().replace(/^https?:\/\//, "").split(/[\/?#]/)[0];
		for(var i = 0; i < PROVIDER_RATES.length; i++) {
			if(PROVIDER_RATES[i].pattern.test(host)) {
				return PROVIDER_RATES[i].rate;
			}
		}
		return DEFAULT_PROVIDER_RATE;
	}

	// The typed limit, or null when the field is empty (Auto) or invalid
	function getRateSetting() {
		var value = parseFloat($("#rate-limit-box").val());
		if(isNaN(value) || value <= 0) {
			return null;
		}
		return Math.min(value, 1000);
	}

	// Requests per second for a download of totalTiles, or null for no limit
	function getRateLimit(totalTiles) {
		var typed = getRateSetting();
		if(typed) {
			return typed;
		}
		return totalTiles > AUTO_RATE_LIMIT_TILES ? getProviderRate() : null;
	}

	function updateRateHelp() {
		$("#rate-limit-help").text(
			"Empty = Auto: no limit up to " + AUTO_RATE_LIMIT_TILES.toLocaleString() + " tiles, then " + formatRate(getProviderRate()) +
			" requests/s for this provider. If the server still refuses, downloading pauses, slows down and retries refused tiles."
		);
	}

	function initializeRateLimit() {
		$("#source-box, #source-select").on("input change", updateRateHelp);
		$("#rate-limit-box").on("input change", updateTileSummary);
		updateRateHelp();
	}

	function getOutputScale() {
		return parseInt($("#output-scale").val(), 10) || 1;
	}

	function getSupersample() {
		return parseInt($("#output-supersample").val(), 10) || 1;
	}

	// Each saved tile is built from an n x n grid of source tiles, n = scale x supersample
	function getRequestsPerTile() {
		var n = getOutputScale() * getSupersample();
		return n * n;
	}

	function getFetchDepth() {
		return Math.log2(getOutputScale() * getSupersample());
	}

	function formatMegabytes(megabytes) {
		if(megabytes >= 1024) {
			return (megabytes / 1024).toFixed(1) + " GB";
		}
		return Math.max(1, Math.round(megabytes)) + " MB";
	}

	// Grid preview

	function initializeGridPreview() {
		$("#grid-preview-button").click(previewGrid);

		map.on('click', showTilePopup);
	}

	function showTilePopup(e) {

		if(!e.originalEvent.ctrlKey) {
			return;
		}

		var zoomRange = getZoomRange();
		var zoom = zoomRange ? zoomRange.top : Math.round(map.getZoom());

		var x = long2tile(e.lngLat.lng, zoom);
		var y = lat2tile(e.lngLat.lat, zoom);

		var content = "X, Y, Z<br/><b>" + x + ", " + y + ", " + zoom + "</b><hr/>";
		content += "Lat, Lng<br/><b>" + e.lngLat.lat.toFixed(6) + ", " + e.lngLat.lng.toFixed(6) + "</b>";

		new maplibregl.Popup()
			.setLngLat(e.lngLat)
			.setHTML(content)
			.addTo(map);
	}

	function removeGrid() {
		removeLayer("grid-preview");
	}

	function previewGrid() {

		var region = getRegion();
		var zoomRange = getZoomRange();

		if(!region || !zoomRange) {
			M.toast({html: 'Select a region and valid zoom levels first.', displayLength: 3000});
			return;
		}

		var count = countTiles(region, zoomRange.top);

		if(count > MAX_PREVIEW_TILES) {
			M.toast({html: 'Too many tiles to draw (' + count.toLocaleString() + ' at zoom ' + zoomRange.top + '). Zoom the grid preview out or shrink the region.', displayLength: 5000});
			return;
		}

		var rings = getGrid(region, zoomRange.top).map(function(tile) {
			return getTileRing(tile.x, tile.y, tile.z);
		});

		removeGrid();

		map.addLayer({
			'id': "grid-preview",
			'type': 'line',
			'source': {
				'type': 'geojson',
				'data': {
					type: "Feature",
					properties: {},
					geometry: { type: "MultiLineString", coordinates: rings },
				},
			},
			'layout': {},
			'paint': {
				"line-color": "#fa8231",
				"line-width": 2,
			}
		});
	}

	function removeLayer(id) {
		if(map.getSource(id) != null) {
			map.removeLayer(id);
			map.removeSource(id);
		}
	}

	// Output options

	function initializeMoreOptions() {

		$("#more-options-toggle").click(function() {
			$("#more-options").toggle();
			$("#more-options-caret").text($("#more-options").is(":visible") ? "−" : "+");
		})

		var outputFileBox = $("#output-file-box")

		function updateStitchCheckboxState() {
			var outputType = $("#output-type").val();
			if (outputType !== "directory") {
				$("#stitch-checkbox").prop("checked", false).prop("disabled", true);
			} else {
				$("#stitch-checkbox").prop("disabled", false);
			}
		}

		$("#output-type").change(function() {
			var outputType = $("#output-type").val();
			if(outputType == "mbtiles") {
				outputFileBox.val("tiles.mbtiles")
			} else if(outputType == "repo") {
				outputFileBox.val("tiles.repo")
			} else if(outputType == "directory") {
				outputFileBox.val("{z}/{x}/{y}.jpg")
			}
			updateStitchCheckboxState();
			saveSettings();
		})

		$("#output-scale, #output-supersample").change(updateTileSummary);

		// Picking a supersample setting fills in its matching zoom interval; it can still be changed
		$("#output-supersample").change(function() {
			$("#zoom-interval-box").val(intervalForSupersample(getSupersample())).trigger("change");
		});

		updateStitchCheckboxState();

	}

	// Downloading

	var stats = null;
	var activeTiles = {};
	var logLines = [];
	var renderScheduled = false;

	function initializeDownloader() {

		bar = new ProgressBar.Circle($('#progress-radial').get(0), {
			strokeWidth: 12,
			easing: 'easeOut',
			duration: 200,
			trailColor: '#eee',
			trailWidth: 1,
			from: {color: '#0fb9b1', a:0},
			to: {color: '#20bf6b', a:1},
			svgStyle: null,
			step: function(state, circle) {
				circle.path.setAttribute('stroke', state.color);
			}
		});

		$("#download-button").click(startDownloading)
		$("#stop-button").click(onStopButton)
	}

	function setPhase(title, hint) {
		$("#download-phase-title").text(title);
		$("#download-phase-hint").text(hint);
	}

	function setStopButton(text, finished) {
		$("#stop-button")
			.text(text)
			.prop("disabled", false)
			.toggleClass("red lighten-5", !finished)
			.toggleClass("cyan darken-2", finished);
	}

	function validateBeforeDownload() {
		if(!getRegion()) {
			return 'You need to select a region first.';
		}
		if(!getZoomRange()) {
			return ZOOM_LIMITS_TEXT;
		}
		if(!validateSource()) {
			return 'The tile URL is not valid.';
		}
		var threads = parseInt($("#parallel-threads-box").val(), 10);
		if(isNaN(threads) || threads < 1 || threads > 32) {
			return 'Parallel downloads must be between 1 and 32.';
		}
		if($("#rate-limit-box").val().trim() != "" && getRateSetting() === null) {
			return 'Max requests per second must be a number above 0, or empty for Auto.';
		}
		return null;
	}

	async function startDownloading() {

		var error = validateBeforeDownload();
		if(error) {
			M.toast({html: error, displayLength: 4000});
			return;
		}

		var region = getRegion();
		var zoomRange = getZoomRange();
		var allTiles = getAllGridTiles(region, zoomRange);

		var requestsPerTile = getRequestsPerTile();
		var totalRequests = allTiles.length * requestsPerTile;

		if(totalRequests > LARGE_DOWNLOAD_TILES &&
			!confirm("This will make " + totalRequests.toLocaleString() + " requests to the tile server, which can take a long time and may get you rate limited. Continue?")) {
			return;
		}

		var rateLimit = getRateLimit(allTiles.length);

		cancellationToken = false;
		inflightRequests = new Set();
		activeTiles = {};
		stats = { done: 0, saved: 0, skipped: 0, failed: 0, total: allTiles.length, startTime: Date.now(), endTime: null };
		downloadState = "running";

		$("#main-sidebar").hide();
		$("#download-sidebar").show();
		$(".tile-strip").html("");
		setStopButton("Stop", false);
		removeGrid();
		clearLogs();
		M.Toast.dismissAll();

		var source = $("#source-box").val()
		var sourceHost = source.replace(/^https?:\/\//, "").split("/")[0];
		setPhase("Downloading tiles", "Fetching " + allTiles.length.toLocaleString() + " tiles from " + sourceHost + " into output/" + resolveOutputDirectory().split("{timestamp}").join("<timestamp>") + "/");
		bar.set(0);
		scheduleRender();

		var timestamp = Date.now().toString();

		var numThreads = parseInt($("#parallel-threads-box").val(), 10);
		var outputDirectory = resolveOutputDirectory();
		var outputFile = $("#output-file-box").val();
		var outputType = $("#output-type").val();
		var outputScale = $("#output-scale").val();
		var supersample = getSupersample();

		var bounds = region.bounds;
		var boundsArray = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
		var centerArray = [bounds.getCenter().lng, bounds.getCenter().lat, zoomRange.top]

		var data = new FormData();
		data.append('minZoom', zoomRange.min)
		data.append('maxZoom', zoomRange.top)
		data.append('outputDirectory', outputDirectory)
		data.append('outputFile', outputFile)
		data.append('outputType', outputType)
		data.append('outputScale', outputScale)
		data.append('source', source)
		data.append('timestamp', timestamp)
		data.append('bounds', boundsArray.join(","))
		data.append('center', centerArray.join(","))

		var outputPath = null;

		try {
			var response = await postForm("/start-download", data);
			outputPath = response.outputPath || null;
		} catch(e) {
			downloadState = "stopped";
			logItemRaw("Could not start the download: the server did not respond.");
			setPhase("Download failed", "Is server.py still running?");
			setStopButton("Back", true);
			return;
		}

		var finished = false;
		var refusedWarned = false;

		limiter = createLimiter(rateLimit);
		renderTicker = setInterval(scheduleRender, 1000);

		if(rateLimit) {
			logItemRaw("Pacing requests to " + formatRate(rateLimit) + " requests/s");
		}

		// Tiles go through a queue rather than a fixed list so refused tiles can be retried
		downloadQueue = async.queue(function(item, done) {
			if(cancellationToken) {
				return done();
			}

			acquireSlot(requestsPerTile, function() {
				if(cancellationToken) {
					return done();
				}
				downloadTile(item, done);
			});
		}, numThreads);

		if(allTiles.length == 0) {
			finishDownload();
		} else {
			downloadQueue.push(allTiles);
		}

		function downloadTile(item, done) {

			var key = item.x + '-' + item.y + '-' + item.z;
			activeTiles[key] = item;
			scheduleRender();

			var data = new FormData();
			data.append('x', item.x)
			data.append('y', item.y)
			data.append('z', item.z)
			data.append('quad', generateQuadKey(item.x, item.y, item.z))
			data.append('outputDirectory', outputDirectory)
			data.append('outputFile', outputFile)
			data.append('outputType', outputType)
			data.append('outputScale', outputScale)
			data.append('supersample', supersample)
			data.append('timestamp', timestamp)
			data.append('source', source)
			data.append('bounds', boundsArray.join(","))
			data.append('center', centerArray.join(","))

			var request = $.ajax({
				url: "/download-tile",
				async: true,
				// the server fetches a tile's sources 4 at a time
				timeout: 30 * 1000 * Math.max(1, requestsPerTile / 4),
				type: "post",
			    contentType: false,
			    processData: false,
				data: data,
				dataType: 'json',
			}).done(function(data) {

				if(cancellationToken) {
					return;
				}

				if(data.code == 200) {
					if(data.exists) {
						stats.skipped++;
						refundSlot(requestsPerTile);
					} else {
						stats.saved++;
						showTinyTile(data.image)
					}
					logItem(item.x, item.y, item.z, data.message);
					noteSuccess();
					tileFinished(item);
				} else if(data.code == 403 || data.code == 429 || data.code == -1 || data.code >= 500) {
					// Refused, dropped or failing: the server is probably overloaded or limiting us
					var reason = data.code == 403 || data.code == 429 ? data.code + " Refused by tile server" : data.code + " Tile server error";
					if(retryTile(item, reason)) {
						var pause = backOff();
						if(pause) {
							logItemRaw("Tile server is limiting requests: pausing " + pause.seconds + "s, then continuing at " + formatRate(pause.rate) + " requests/s");
							if(!refusedWarned) {
								refusedWarned = true;
								M.toast({html: 'The tile server is limiting requests. Pausing and slowing down; refused tiles will be retried.', displayLength: 8000});
							}
						}
					} else {
						stats.failed++;
						logItem(item.x, item.y, item.z, reason + ", giving up");
						tileFinished(item);
					}
				} else {
					stats.failed++;
					logItem(item.x, item.y, item.z, data.code + " Error downloading tile");
					tileFinished(item);
				}

			}).fail(function(data, textStatus, errorThrown) {

				if(cancellationToken) {
					return;
				}

				if(!retryTile(item, "Error while relaying tile")) {
					stats.failed++;
					logItem(item.x, item.y, item.z, "Error while relaying tile, giving up");
					tileFinished(item);
				}

			}).always(function(data) {
				inflightRequests.delete(request);
				delete activeTiles[key];
				scheduleRender();
				done();
			});

			inflightRequests.add(request);
		}

		// Puts a tile back in the queue unless it has used up its attempts
		function retryTile(item, reason) {
			item.attempts = (item.attempts || 1) + 1;
			if(item.attempts > MAX_TILE_ATTEMPTS) {
				return false;
			}

			logItem(item.x, item.y, item.z, reason + ", will retry (attempt " + item.attempts + " of " + MAX_TILE_ATTEMPTS + ")");
			downloadQueue.push(item);
			return true;
		}

		function tileFinished(item) {
			stats.done++;
			scheduleRender();

			if(stats.done >= stats.total) {
				finishDownload();
			}
		}

		async function finishDownload() {
			if(finished) {
				return;
			}
			finished = true;

			try {
				await postForm("/end-download", data);
			} catch(e) {
				logItemRaw("Could not finalize the output.");
			}

			stats.endTime = Date.now();
			clearInterval(renderTicker);
			activeTiles = {};
			logItemRaw("All requests are done");
			scheduleRender();

			if ($("#stitch-checkbox").is(":checked")) {
				await stitchTiles(outputDirectory, timestamp, zoomRange, boundsArray);
			}

			downloadState = "finished";
			setPhase("Download complete", describeResult(outputPath));
			setStopButton("Done", true);
		}

	}

	// Rate limiting. Requests to the tile server are spaced out to at most `rate` per second
	// (none when rate is null). If the server starts refusing, downloading pauses, the rate
	// halves, and the refused tiles are retried.

	var limiter = null;
	var downloadQueue = null;
	var inflightRequests = new Set();
	var renderTicker = null;

	function createLimiter(rate) {
		return { rate: rate, nextSlot: 0, pausedUntil: 0, strikes: 0, cleanStreak: 0, sent: 0 };
	}

	// Calls back once `cost` requests may be sent
	function acquireSlot(cost, callback) {
		var now = Date.now();
		var start = Math.max(now, limiter.nextSlot, limiter.pausedUntil);
		limiter.nextSlot = limiter.rate ? start + cost * 1000 / limiter.rate : start;
		limiter.sent += cost;

		if(start > now) {
			setTimeout(callback, start - now);
		} else {
			callback();
		}
	}

	// Tiles already on disk make no requests to the tile server, so their slot is given back
	function refundSlot(cost) {
		limiter.sent -= cost;
		if(limiter.rate) {
			limiter.nextSlot = Math.max(Date.now(), limiter.nextSlot - cost * 1000 / limiter.rate);
		}
	}

	// Pauses (30s, doubling on repeat strikes up to 5 min) and halves the rate. Refusals that
	// arrive while already paused belong to the same strike, so they return null
	function backOff() {
		var now = Date.now();
		if(now < limiter.pausedUntil) {
			return null;
		}

		limiter.strikes++;
		limiter.cleanStreak = 0;

		var seconds = Math.min(30 * Math.pow(2, limiter.strikes - 1), 300);
		var elapsed = Math.max((now - stats.startTime) / 1000, 1);
		var current = limiter.rate || Math.max(limiter.sent / elapsed, 1);

		limiter.rate = Math.max(current / 2, MIN_RATE);
		limiter.pausedUntil = now + seconds * 1000;
		limiter.nextSlot = Math.max(limiter.nextSlot, limiter.pausedUntil);

		return { seconds: seconds, rate: limiter.rate };
	}

	// After a long run without refusals, the next pause starts short again
	function noteSuccess() {
		limiter.cleanStreak++;
		if(limiter.cleanStreak >= 100) {
			limiter.strikes = 0;
		}
	}

	function formatRate(rate) {
		return rate >= 10 ? Math.round(rate).toString() : (Math.round(rate * 10) / 10).toString();
	}

	function describeResult(outputPath) {
		var text = stats.saved.toLocaleString() + " saved, " + stats.skipped.toLocaleString() + " already on disk";
		if(stats.failed > 0) {
			text += ", " + stats.failed.toLocaleString() + " failed (see log)";
		}
		text += ".";
		if(outputPath) {
			text += " Output: " + outputPath;
		}
		return text;
	}

	async function stitchTiles(outputDirectory, timestamp, zoomRange, boundsArray) {
		downloadState = "stitching";
		$("#stop-button").text("Stitching...").prop("disabled", true);
		setPhase("Stitching tiles", "Building an image from the tiles, please wait...");

		var stitchData = new FormData();
		stitchData.append('outputDirectory', outputDirectory);
		stitchData.append('timestamp', timestamp);
		stitchData.append('minZoom', zoomRange.min);
		stitchData.append('maxZoom', zoomRange.top);
		stitchData.append('zooms', zoomRange.levels.join(","));
		stitchData.append('bounds', boundsArray.join(","));

		try {
			var response = await postForm("/stitch-tiles", stitchData);
			if(response.code != 200) {
				logItemRaw("Stitching skipped: " + response.message);
				M.toast({html: escapeHtml(response.message), displayLength: 6000});
				return;
			}
		} catch(e) {
			logItemRaw("Could not start stitching.");
			return;
		}

		await pollStitchStatus();
	}

	function pollStitchStatus() {
		return new Promise(function(resolve) {
			var lastMessage = "";
			var interval = setInterval(function() {
				$.ajax({
					url: "/stitch-status",
					async: true,
					type: "get",
					dataType: 'json',
				}).done(function(status) {
					if (status.message !== lastMessage) {
						lastMessage = status.message;
						logItemRaw(status.message);
					}
					if (status.state === "done") {
						clearInterval(interval);
						for (var i = 0; i < status.files.length; i++) {
							logItemRaw("Saved: " + status.files[i]);
						}
						resolve();
					} else if (status.state === "error") {
						clearInterval(interval);
						M.toast({html: 'Stitching failed, see the log.', displayLength: 6000});
						resolve();
					}
				}).fail(function() {
					clearInterval(interval);
					logItemRaw("Could not reach stitch status endpoint.");
					resolve();
				});
			}, 2000);
		});
	}

	function postForm(url, data) {
		return $.ajax({
			url: url,
			async: true,
			timeout: 30 * 1000,
			type: "post",
			contentType: false,
			processData: false,
			data: data,
			dataType: 'json',
		});
	}

	function showTinyTile(base64) {
		if(!base64) {
			return;
		}

		var strip = $(".tile-strip");
		strip.children("img").slice(4).remove();
		strip.prepend($("<img/>").attr('src', "data:image/jpeg;base64, " + base64));
	}

	// Progress, stats, log and the in-flight tile outlines are redrawn at most
	// once per frame, so thousands of fast responses don't stall the page

	function scheduleRender() {
		if(renderScheduled) {
			return;
		}
		renderScheduled = true;
		requestAnimationFrame(render);
	}

	function render() {
		renderScheduled = false;

		if(!stats) {
			return;
		}

		var progress = stats.total == 0 ? 1 : stats.done / stats.total;
		bar.set(progress);
		bar.setText(Math.floor(progress * 100) + '<span>%</span>');

		$("#progress-subtitle").html(stats.done.toLocaleString() + " <span>of</span> " + stats.total.toLocaleString())
		$("#progress-rate").text(describeRate());

		$("#stat-saved").text(stats.saved.toLocaleString());
		$("#stat-skipped").text(stats.skipped.toLocaleString());
		$("#stat-failed").text(stats.failed.toLocaleString()).toggleClass("has-failures", stats.failed > 0);

		var logger = $('#log-view');
		logger.val(logLines.join('\n'));
		logger.scrollTop(logger[0].scrollHeight);

		var source = map.getSource("active-tiles");
		if(source) {
			var features = Object.keys(activeTiles).map(function(key) {
				var tile = activeTiles[key];
				return {
					type: "Feature",
					properties: {},
					geometry: { type: "Polygon", coordinates: [getTileRing(tile.x, tile.y, tile.z)] },
				};
			});
			source.setData({ type: "FeatureCollection", features: features });
		}
	}

	function describeRate() {
		var end = stats.endTime || Date.now();
		var seconds = (end - stats.startTime) / 1000;

		if(stats.endTime) {
			return (downloadState == "stopped" ? "Stopped after " : "Finished in ") + formatDuration(seconds);
		}

		if(limiter && Date.now() < limiter.pausedUntil) {
			return "Paused, the tile server is limiting requests · resuming in " + formatDuration((limiter.pausedUntil - Date.now()) / 1000);
		}

		if(stats.done == 0 || seconds < 1) {
			return limiter && limiter.rate ? "Pacing at " + formatRate(limiter.rate) + " requests/s" : "";
		}

		var rate = stats.done / seconds;
		var remaining = (stats.total - stats.done) / rate;
		var pace = limiter && limiter.rate ? " · max " + formatRate(limiter.rate) + " req/s" : "";
		return rate.toFixed(1) + " tiles/s" + pace + " · about " + formatDuration(remaining) + " left";
	}

	function formatDuration(seconds) {
		seconds = Math.round(seconds);
		var h = Math.floor(seconds / 3600);
		var m = Math.floor(seconds % 3600 / 60);
		var s = seconds % 60;

		if(h > 0) {
			return h + "h " + m + "m";
		}
		if(m > 0) {
			return m + "m " + s + "s";
		}
		return s + "s";
	}

	function logItem(x, y, z, text) {
		logItemRaw(x + ',' + y + ',' + z + ' : ' + text)
	}

	function logItemRaw(text) {
		logLines.push(text);
		if(logLines.length > MAX_LOG_LINES) {
			logLines.splice(0, logLines.length - MAX_LOG_LINES);
		}
		scheduleRender();
	}

	function clearLogs() {
		logLines = [];
		$('#log-view').val('');
	}

	function onStopButton() {
		if(downloadState == "running") {
			stopDownloading();
		} else if(downloadState == "finished" || downloadState == "stopped") {
			closeDownloadSidebar();
		}
	}

	function stopDownloading() {
		cancellationToken = true;
		downloadState = "stopped";

		if(downloadQueue) {
			downloadQueue.kill();
		}
		clearInterval(renderTicker);

		inflightRequests.forEach(function(request) {
			try {
				request.abort();
			} catch(e) {

			}
		});
		inflightRequests = new Set();

		stats.endTime = Date.now();
		activeTiles = {};
		logItemRaw("Stopped by user");
		scheduleRender();

		setPhase("Download stopped", describeResult(null) + " Tiles already saved are kept, and are skipped if you download the same region again.");
		setStopButton("Back", true);
	}

	function closeDownloadSidebar() {
		downloadState = null;
		$("#main-sidebar").show();
		$("#download-sidebar").hide();
		removeGrid();
		clearLogs();
	}

	initializeSettings();
	initializeSources();
	initializeMaterialize();
	initializeMap();
	initializeSearch();
	initializeRegionTools();
	initializeGridPreview();
	initializeZoom();
	initializeMoreOptions();
	initializeDownloader();
	initializeOutputPreview();
	initializeRateLimit();
	updateTileSummary();
});
