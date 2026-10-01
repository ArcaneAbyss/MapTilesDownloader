$(function() {

	var map = null;
	var mapLoaded = false;
	var draw = null;
	var bar = null;

	var cancellationToken = null;
	var requests = [];

	// "running" while tiles download, "stitching" while the stitcher runs,
	// "finished" or "stopped" once the download sidebar can be closed
	var downloadState = null;

	var MAX_ZOOM = 24;
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
		"#output-type",
		"#output-scale",
		"#output-supersample",
		"#output-directory-box",
		"#output-file-box",
		"#parallel-threads-box",
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

	// Region selection

	function initializeRectangleTool() {

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

		$("#rectangle-draw-button").click(startDrawing);
		$("#use-view-button").click(useCurrentView);
	}

	function startDrawing() {
		removeGrid();
		draw.deleteAll();
		draw.changeMode('draw_rectangle');
		onRegionChanged();

		M.Toast.dismissAll();
		M.toast({html: 'Click two corners on the map to draw a rectangle.', displayLength: 7000})
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

	function getRegion() {
		if(!draw) {
			return null;
		}

		var features = draw.getAll().features;
		var feature = features[0];

		// While drawing, the rectangle mode holds an unfinished feature with no area
		if(!feature || feature.geometry.coordinates[0].length < 4) {
			return null;
		}

		var bounds = getBounds(feature);
		if(bounds.getWest() == bounds.getEast() || bounds.getSouth() == bounds.getNorth()) {
			return null;
		}

		return {
			feature: feature,
			bounds: bounds,
			isRectangle: isRectangle(feature, bounds),
		};
	}

	function getBounds(feature) {

		var coordinates = feature.geometry.coordinates[0];

		var bounds = coordinates.reduce(function(bounds, coord) {
			return bounds.extend(coord);
		}, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));

		return bounds;
	}

	// An axis-aligned rectangle covers every tile in its bounding box, so the
	// per-tile polygon intersection test can be skipped
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
		updateRegionInfo();
		updateTileSummary();
	}

	function updateRegionInfo() {
		var region = getRegion();

		if(!region) {
			$("#region-info").text("No region selected yet.");
			return;
		}

		var bounds = region.bounds;
		var center = bounds.getCenter();
		var width = distanceKm(bounds.getWest(), center.lat, bounds.getEast(), center.lat);
		var height = distanceKm(center.lng, bounds.getSouth(), center.lng, bounds.getNorth());

		$("#region-info").html(
			"<b>" + formatKm(width) + " × " + formatKm(height) + "</b> around " +
			center.lat.toFixed(4) + ", " + center.lng.toFixed(4) +
			"<br/>Drag it to move, or draw again to replace it."
		);
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
		$("#zoom-from-box, #zoom-to-box").on("input change", function() {
			removeGrid();
			updateTileSummary();
		});
	}

	function parseZoom(id) {
		var value = parseInt($(id).val(), 10);
		if(isNaN(value) || value < 0 || value > MAX_ZOOM) {
			return null;
		}
		return value;
	}

	function getZoomRange() {
		var from = parseZoom("#zoom-from-box");
		var to = parseZoom("#zoom-to-box");

		if(from === null || to === null) {
			return null;
		}

		var min = Math.min(from, to);
		var max = Math.max(from, to);
		var step = getZoomStep();

		var levels = [];
		for(var z = min; z <= max; z += step) {
			levels.push(z);
		}

		// top is the deepest level actually downloaded, which can be below max when stepping
		return { min: min, max: max, step: step, levels: levels, top: levels[levels.length - 1] };
	}

	// A supersampled tile already holds the detail of the next levels down (2x draws on zoom +1,
	// 4x on zoom +2), so those levels are skipped: 2x saves every 2nd zoom, 4x every 3rd, 8x every 4th
	function getZoomStep() {
		return Math.log2(getSupersample()) + 1;
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

	function isTileInSelection(region, x, y, zoom) {
		if(region.isRectangle) {
			return true;
		}

		var polygon = turf.polygon([getTileRing(x, y, zoom)]);
		return turf.booleanDisjoint(polygon, region.feature) == false;
	}

	function getGrid(region, zoom) {

		var range = getTileRange(region.bounds, zoom);
		var tiles = [];

		for(var y = range.top; y <= range.bottom; y++) {
			for(var x = range.left; x <= range.right; x++) {
				if(isTileInSelection(region, x, y, zoom)) {
					tiles.push({ x: x, y: y, z: zoom });
				}
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
			summary.text("Zoom levels must be whole numbers from 0 to " + MAX_ZOOM + ".");
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

		var ordinal = { 2: "2nd", 3: "3rd", 4: "4th" }[zoomRange.step];
		var text = getSupersample() + "× supersample saves every " + ordinal + " zoom: " + zoomRange.levels.join(", ");
		if(zoomRange.top != zoomRange.max) {
			text += " (zoom " + zoomRange.max + " is not on a step, so " + zoomRange.top + " is the deepest)";
		}
		hint.text(text).show();
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
			return 'Zoom levels must be whole numbers from 0 to ' + MAX_ZOOM + '.';
		}
		if(!validateSource()) {
			return 'The tile URL is not valid.';
		}
		var threads = parseInt($("#parallel-threads-box").val(), 10);
		if(isNaN(threads) || threads < 1 || threads > 32) {
			return 'Parallel downloads must be between 1 and 32.';
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

		cancellationToken = false;
		requests = [];
		activeTiles = {};
		stats = { done: 0, saved: 0, skipped: 0, failed: 0, total: allTiles.length, startTime: Date.now(), endTime: null };
		downloadState = "running";
		var rateLimitWarned = false;

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

		async.eachLimit(allTiles, numThreads, function(item, done) {

			if(cancellationToken) {
				return;
			}

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
					} else {
						stats.saved++;
						showTinyTile(data.image)
					}
					logItem(item.x, item.y, item.z, data.message);
				} else if(data.code == 403 || data.code == 429) {
					stats.failed++;
					logItem(item.x, item.y, item.z, data.code + " Rate limited by tile server");
					if(!rateLimitWarned) {
						rateLimitWarned = true;
						M.toast({html: 'Tile server is rate limiting requests. Try a different source or wait a few minutes.', displayLength: 8000});
					}
				} else {
					stats.failed++;
					logItem(item.x, item.y, item.z, data.code + " Error downloading tile");
				}

			}).fail(function(data, textStatus, errorThrown) {

				if(cancellationToken) {
					return;
				}

				stats.failed++;
				logItem(item.x, item.y, item.z, "Error while relaying tile");

			}).always(function(data) {
				if(cancellationToken) {
					return;
				}

				stats.done++;
				delete activeTiles[key];
				scheduleRender();

				done();
			});

			requests.push(request);

		}, async function(err) {

			try {
				await postForm("/end-download", data);
			} catch(e) {
				logItemRaw("Could not finalize the output.");
			}

			stats.endTime = Date.now();
			activeTiles = {};
			logItemRaw("All requests are done");
			scheduleRender();

			if ($("#stitch-checkbox").is(":checked")) {
				await stitchTiles(outputDirectory, timestamp, zoomRange, boundsArray);
			}

			downloadState = "finished";
			setPhase("Download complete", describeResult(outputPath));
			setStopButton("Done", true);
		});

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

		if(stats.done == 0 || seconds < 1) {
			return "";
		}

		var rate = stats.done / seconds;
		var remaining = (stats.total - stats.done) / rate;
		return rate.toFixed(1) + " tiles/s · about " + formatDuration(remaining) + " left";
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

		for(var i =0 ; i < requests.length; i++) {
			var request = requests[i];
			try {
				request.abort();
			} catch(e) {

			}
		}

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
	initializeRectangleTool();
	initializeGridPreview();
	initializeZoom();
	initializeMoreOptions();
	initializeDownloader();
	initializeOutputPreview();
	updateTileSummary();
});
