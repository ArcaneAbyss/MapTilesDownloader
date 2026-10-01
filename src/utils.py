#!/usr/bin/env python

from urllib.parse import urlparse
from urllib.parse import parse_qs
from urllib.parse import parse_qsl
import urllib.request
import uuid
import random
import string
import argparse
import uuid
import random
import time
import json
import shutil
import ssl
import glob
import os
import base64
import math
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

class Utils:
	
	@staticmethod
	def randomString():
		return uuid.uuid4().hex.upper()[0:6]

	def makeQuadKey(tile_x, tile_y, level):
		quadkey = ""
		for i in range(level):
			bit = level - i
			digit = ord('0')
			mask = 1 << (bit - 1)  # if (bit - 1) > 0 else 1 >> (bit - 1)
			if (tile_x & mask) != 0:
				digit += 1
			if (tile_y & mask) != 0:
				digit += 2
			quadkey += chr(digit)
		return quadkey

	@staticmethod
	def num2deg(xtile, ytile, zoom):
		n = 2.0 ** zoom
		lon_deg = xtile / n * 360.0 - 180.0
		lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * ytile / n)))
		lat_deg = math.degrees(lat_rad)
		return (lat_deg, lon_deg)

	@staticmethod
	def qualifyURL(url, x, y, z):

		scale22 = 23 - (z * 2)

		replaceMap = {
			"x": str(x),
			"y": str(y),
			"z": str(z),
			"scale:22": str(scale22),
			"quad": Utils.makeQuadKey(x, y, z),
		}

		for key, value in replaceMap.items():
			newKey = str("{" + str(key) + "}")
			url = url.replace(newKey, value)

		return url

	@staticmethod
	def downloadFile(url, destination, x, y, z):

		url = Utils.qualifyURL(url, x, y, z)

		code = 0

		# monkey patching SSL certificate issue
		# DONT use it in a prod/sensitive environment
		ssl._create_default_https_context = ssl._create_unverified_context

		headers = {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
			'Referer': 'https://www.google.com/maps/',
			'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
			'Accept-Language': 'en-US,en;q=0.9',
		}

		# Retry dropped connections and server errors a couple of times; tile servers
		# under load often reset a connection that succeeds a moment later
		for attempt in range(3):
			try:
				req = urllib.request.Request(url, headers=headers)
				with urllib.request.urlopen(req, timeout=30) as response:
					with open(destination, 'wb') as f:
						shutil.copyfileobj(response, f)
				return 200
			except urllib.error.HTTPError as e:
				code = e.code
				if code < 500:
					break
			except OSError as e:
				# URLError, connection resets and timeouts are all OSErrors
				print(e)
				code = -1

			if os.path.isfile(destination):
				os.remove(destination)
			if attempt < 2:
				time.sleep(attempt + 1)

		# Never leave a partial download behind to be saved as a tile
		if os.path.isfile(destination):
			os.remove(destination)

		return code


	@staticmethod
	def convertToJpeg(path):
		# Sources serve PNG, JPEG or WebP; normalise to JPEG in place
		with Image.open(path) as image:
			if image.format == "JPEG":
				return
			if image.mode in ("RGBA", "LA", "P"):
				image = image.convert("RGBA")
				background = Image.new("RGB", image.size, (255, 255, 255))
				background.paste(image, mask=image.getchannel("A"))
				image = background
			else:
				image = image.convert("RGB")
			image.load()
		image.save(path, "JPEG", quality=90)


	@staticmethod
	def downloadFileScaled(url, destination, x, y, z, outputScale, supersample=1):

		if outputScale == 1 and supersample == 1:
			return Utils.downloadFile(url, destination, x, y, z)

		# Build the tile from an n x n grid of tiles `depth` zoom levels deeper.
		# outputScale keeps the full resolution (2x = 512px), supersample
		# downsizes the grid afterwards (4x = 1024px canvas shrunk to 256px).
		n = outputScale * supersample
		depth = int(math.log2(n))
		childZ = z + depth

		children = [(x * n + dx, y * n + dy) for dy in range(n) for dx in range(n)]
		tempDir = os.path.dirname(destination)

		def fetchChild(child):
			childX, childY = child
			tempFilePath = os.path.join(tempDir, Utils.randomString() + ".tile")
			try:
				code = Utils.downloadFile(url, tempFilePath, childX, childY, childZ)
				if code != 200:
					return code, None
				with Image.open(tempFilePath) as image:
					return code, image.convert("RGB")
			finally:
				if os.path.isfile(tempFilePath):
					os.remove(tempFilePath)

		with ThreadPoolExecutor(max_workers=min(4, len(children))) as pool:
			results = list(pool.map(fetchChild, children))

		for code, image in results:
			if image is None:
				return code

		tileWidth, tileHeight = results[0][1].size
		canvas = Image.new("RGB", (tileWidth * n, tileHeight * n))

		for (childX, childY), (code, image) in zip(children, results):
			canvas.paste(image, ((childX - x * n) * tileWidth, (childY - y * n) * tileHeight))

		if supersample > 1:
			canvas = canvas.resize((tileWidth * outputScale, tileHeight * outputScale), Image.LANCZOS)

		canvas.save(destination, "JPEG", quality=90)

		return 200
