# Map Tiles Downloader

**A super easy to use GUI for downloading map tiles**

<p align="center">
  <img src="gif/map-tiles-downloader.gif">
</p>

## So what does it do?

This tiny python based script allows you to download map tiles from Google, Bing, Open Street Maps, ESRI, and other providers. This script comes with an easy to use web based map UI for selecting the area and previewing tiles.

**Just run the script via command line**

```sh
cd src
python server.py
```

Then open up your web browser and navigate to `http://localhost:8080`. The output map tiles will be in the `src/output/{timestamp}/` directory by default.

## Requirements

Needs **Python 3.13+** and a modern web browser. Install dependencies with:

```sh
pip install -r requirements.txt
```

| Package | Purpose |
|---------|---------|
| [Pillow](https://pypi.org/project/Pillow/) | Tile scaling (2x/Hi-Res output) |
| [pyvips](https://pypi.org/project/pyvips/) | Tile stitching — memory-efficient image assembly |

On Windows, `pyvips[binary]` bundles the required libvips DLLs automatically. On Linux/macOS, install libvips via your package manager (`apt install libvips` / `brew install vips`) before running pip.

> **Note:** The `cgi` module was removed in Python 3.13. This repo has been updated to use the `email` module as a replacement. Python versions older than 3.13 are not tested with the current code.

## Via Docker

Docker is a pretty simple way to install and contain applications. [Install Docker on your system](https://www.docker.com/products/docker-desktop), and paste this on your command line:

```sh
docker run -v $PWD/output:/app/output/ -p 8080:8080 -it aliashraf/map-tiles-downloader
```

Now open the browser and head over to `http://localhost:8080`. The downloaded maps will be stored in the `output` directory.

## Purpose

I design map related things as a hobby, and often I have to work with offline maps that require tiles to be stored on my local system. Downloading tiles is a bit of a headache, and the current solutions have user experience issues. So I built this tiny script in a couple of hours to speed up my work.

## Features

- Super easy to use map UI to select region and options
- Select a rectangle, a free-form polygon, or a corridor along a line with a radius
- Multi-threading to download tiles in parallel, with automatic rate limiting for large downloads
- Cross platform, use any OS as long as it has Python and a browser
- Dockerfile available for easy setup
- Supports 2x/Hi-Res/Retina/512x512 tiles by merging multiple tiles
- Supersampling: build each tile from deeper-zoom imagery and downsize it for sharper results
- Supports downloading to file as well as mbtile format
- Select multiple zoom levels in one go
- Ability to ignore tiles already downloaded
- Specify any custom file name format
- Supports ANY tile provider as long as the url has `x`, `y`, `z`, or `quad` in it
- Map rendered with [MapLibre GL JS](https://maplibre.org/) on an OpenStreetMap base map, and place search uses OpenStreetMap Nominatim (no API keys required)
- Live tile count and size estimate, plus an optional on-map preview of the selected tile source
- **Built-in tile stitcher** — assembles all downloaded tiles into a single GeoTIFF with one click, using [libvips](https://www.libvips.org/) for memory-efficient processing of very large images

## Tile Sources

The following providers are available from the dropdown and have been verified working:

| Provider | Type | Notes |
|----------|------|-------|
| Bing Maps | Road | |
| Bing Maps Satellite | Satellite | |
| Bing Maps Hybrid | Satellite + labels | |
| Google Maps | Road | Unofficial endpoint, may be rate-limited |
| Google Maps Satellite | Satellite | Unofficial endpoint, may be rate-limited |
| Google Maps Hybrid | Satellite + labels | Unofficial endpoint, may be rate-limited |
| Google Maps Terrain | Terrain | Unofficial endpoint, may be rate-limited |
| Open Street Maps | Road | |
| Open Cycle Maps | Cycling | |
| ESRI World Imagery | Satellite | Best quality, up to zoom 19-20, free, no key required |
| Sentinel-2 Cloudless (EOX) | Satellite | 2025 cloud-free mosaic, 10 m resolution (useful up to zoom ~14), CC BY-NC-SA 4.0 — non-commercial only |
| Carto Light | Road (minimal) | |

**For the highest quality satellite imagery**, use **ESRI World Imagery** at zoom level 18 or 19.

## Selecting a Region

| Tool | Selects |
|------|---------|
| Rectangle | Click two corners |
| Polygon | Click each corner; click the first corner or double-click to finish |
| Line | Click points along a route and double-click to finish, then set **Radius** (metres). Every tile within that distance of the line is downloaded, shown as a shaded corridor |
| Map view | The area currently on screen |

Click a drawn shape to move it or drag its points. Only tiles that actually touch the shape are downloaded, so a polygon or corridor costs far fewer tiles than its bounding box.

## Zoom Levels

Zoom level controls the detail and tile count. Each level up has 4× more tiles than the previous. Zoom levels range from 1 to 18.

| Zoom | Detail level |
|------|-------------|
| 1–5 | Country / continent |
| 10–12 | City |
| 15–16 | Street (default) |
| 17–18 | Building / maximum detail |

Set **From** and **To** to the same value to download only that level. Set a range to download multiple levels at once (useful for maps that need to work at different scales).

**Every** (1 to 17) saves only every Nth level of the range, counting from **From**: zoom 3 to 16 with Every 3 downloads zoom 3, 6, 9, 12 and 15. A level that falls between steps (16 here) is skipped, and the sidebar lists the levels before you download.

## Output

Tiles are saved in one folder per tile source, in `{z}/{x}/{y}.jpg` structure:

```
src/output/
  esri-world-imagery/          zoom levels from every ESRI download, plus metadata.json
  esri-world-imagery_ss4x/     the same source with 4× supersampling
  bing-maps-satellite_512px/   Bing at 2x output scale
  tiles.example.com/           a custom URL, named after its host
```

Downloading more zoom levels or a neighbouring area from the same source adds to its folder, and tiles you already have are skipped instead of downloaded again. Tiles made with a different output scale or supersample setting go to their own folder so they never get mixed up. Each folder's `metadata.json` records the source URL and the combined bounds and zoom range of everything in it. The sidebar shows the destination folder before you download.

The folder name comes from **Output options → Output directory**, which defaults to `{source}{variant}`. `{source}` is the provider name, `{variant}` marks the output scale and supersampling, and `{timestamp}` gives each download a fresh folder if you prefer that. The UI remembers your last-used source, zoom and output settings.

## Rate Limiting

Tile servers block clients that send too many requests. **Output options → Max requests per second** controls the pace:

- **Empty (Auto)**: no limit up to 2,000 tiles. Above that, a conservative pace for the provider: 25/s for ESRI, 10/s for Bing, EOX and Carto, 4/s for Google, 2/s for OpenStreetMap, 8/s for anything else. None of these providers publish a limit, so these are starting points.
- **A number**: always pace at that many requests per second.

The pace counts requests to the tile server, so a 4× supersampled tile counts as 16. Tiles you already have don't count. The sidebar shows the pace and the expected time before you download.

If the server still refuses requests (403 or 429) or fails, downloading pauses for 30 seconds, continues at half the pace, and retries the refused tiles, up to 3 attempts per tile. Repeated refusals double the pause, up to 5 minutes.

## Supersampling

**Output options → Supersample** builds each tile from sharper imagery a few zoom levels deeper, then downsizes it. For example, at 4×, every zoom 16 tile is made by fetching the 4×4 zoom 18 tiles that cover it, joining them into a 1024px image and resizing that to 256px (Lanczos) before saving it as JPEG.

| Setting | Source zoom | Requests per tile | Default Every |
|---------|-------------|-------------------|-------------------|
| 2× | zoom + 1 | 4 | 2 (3, 5, 7 …) |
| 4× | zoom + 2 | 16 | 3 (3, 6, 9 …) |
| 8× | zoom + 3 | 64 | 4 (3, 7, 11 …) |

Because a supersampled tile already carries the detail of the levels just below it, choosing a supersample setting fills in the matching **Every** interval: zoom 3 to 16 at 4× saves zoom 3, 6, 9, 12 and 15 in one go. You can still change **Every** afterwards.

It combines with **Output scale**: 2x scale with 4× supersample fetches zoom + 3 and saves 512px tiles.

Supersampling suits satellite imagery. On road or hybrid maps, labels and road widths are drawn for the deeper zoom and shrink to unreadable sizes. It also multiplies the number of requests, so you are more likely to be rate limited; the sidebar shows the total request count before you download.

## Stitching Tiles into a Single Image

The downloader includes a built-in stitcher powered by [libvips](https://www.libvips.org/). Unlike Photoshop or Pillow, libvips processes images in strips rather than loading everything into RAM, so it handles multi-gigapixel outputs without running out of memory.

**To use:**
1. Check **Stitch tiles into image after download** (visible above the Download button — only enabled for Directory output type)
2. Start the download as normal
3. Once all tiles have downloaded, stitching begins automatically
4. Progress is shown in the log panel; the button shows **STITCHING...** while it runs
5. Output is saved in the source folder as `stitched_z{zoom}_{timestamp}.tif`, one file per zoom level, covering only the region you just downloaded

The output is a tiled, deflate-compressed TIFF compatible with GIS tools (QGIS, GDAL, ArcGIS) and image editors. For zoom ranges, a separate TIFF is produced for each zoom level.

> **Note:** Stitching is only available when **Output type** is set to **Directory** (the default). MBTiles and Repo formats store tiles internally and don't produce individual image files to stitch from.

## Important Disclaimer

Downloading map tiles is subject to the terms and conditions of the tile provider. Some providers such as Google Maps have restrictions in place to avoid abuse, therefore before downloading any tiles make sure you understand their TOCs. I recommend not using Google, Bing, and ESRI tiles in any commercial application without their consent.

## Stay In Touch

For latest releases and announcements, check out my site: [aliashraf.net](http://aliashraf.net)

## License

This software is released under the [MIT License](LICENSE). Please read LICENSE for information on the
software availability and distribution.

Copyright (c) 2020 [Ali Ashraf](http://aliashraf.net)