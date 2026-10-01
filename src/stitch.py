import math
import os
import pyvips


class Stitcher:

    @staticmethod
    def tile_range(bounds, zoom):
        """Inclusive (min_x, min_y, max_x, max_y) tile range covering bounds = (west, south, east, north)."""
        west, south, east, north = bounds
        n = 2 ** zoom

        def tile_x(lon):
            return min(max(int((lon + 180) / 360 * n), 0), n - 1)

        def tile_y(lat):
            lat = min(max(lat, -85.0511), 85.0511)
            return min(max(int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n), 0), n - 1)

        return tile_x(west), tile_y(north), tile_x(east), tile_y(south)

    @staticmethod
    def stitch_zoom_level(output_dir, zoom, bounds=None, suffix=""):
        """Stitch the tiles of one zoom level. With bounds, only tiles inside them are used,
        so a folder holding several downloads stitches just the requested region."""
        zoom_dir = os.path.join(output_dir, str(zoom))
        if not os.path.isdir(zoom_dir):
            return None

        tile_filter = Stitcher.tile_range(bounds, zoom) if bounds else None

        tile_paths = {}
        for x_name in os.listdir(zoom_dir):
            x_path = os.path.join(zoom_dir, x_name)
            if not os.path.isdir(x_path):
                continue
            try:
                x = int(x_name)
            except ValueError:
                continue
            for y_file in os.listdir(x_path):
                name, ext = os.path.splitext(y_file)
                if ext.lower() in ('.jpg', '.jpeg', '.png'):
                    try:
                        y = int(name)
                    except ValueError:
                        continue
                    if tile_filter and not (tile_filter[0] <= x <= tile_filter[2] and tile_filter[1] <= y <= tile_filter[3]):
                        continue
                    tile_paths[(x, y)] = os.path.join(x_path, y_file)

        all_tiles = list(tile_paths)

        if not all_tiles:
            return None

        min_x = min(t[0] for t in all_tiles)
        max_x = max(t[0] for t in all_tiles)
        min_y = min(t[1] for t in all_tiles)
        max_y = max(t[1] for t in all_tiles)
        cols = max_x - min_x + 1

        first = all_tiles[0]
        sample = pyvips.Image.new_from_file(tile_paths[first])
        tile_w, tile_h, bands = sample.width, sample.height, sample.bands

        images = []
        for y in range(min_y, max_y + 1):
            for x in range(min_x, max_x + 1):
                tile_path = tile_paths.get((x, y))
                if tile_path:
                    images.append(pyvips.Image.new_from_file(tile_path))
                else:
                    images.append(pyvips.Image.black(tile_w, tile_h, bands=bands))

        result = pyvips.Image.arrayjoin(images, across=cols)

        output_path = os.path.join(output_dir, f"stitched_z{zoom}{suffix}.tif")
        result.tiffsave(output_path, tile=True, compression="deflate", bigtiff=True)

        return output_path
