import os
import pyvips


class Stitcher:

    @staticmethod
    def stitch_zoom_level(output_dir, zoom):
        zoom_dir = os.path.join(output_dir, str(zoom))
        if not os.path.isdir(zoom_dir):
            return None

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
                        tile_paths[(x, int(name))] = os.path.join(x_path, y_file)
                    except ValueError:
                        continue

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

        output_path = os.path.join(output_dir, f"stitched_z{zoom}.tif")
        result.tiffsave(output_path, tile=True, compression="deflate", bigtiff=True)

        return output_path
