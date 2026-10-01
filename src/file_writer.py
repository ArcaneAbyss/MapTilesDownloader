import sqlite3
import os
import multiprocessing
import io
import json
import shutil

class FileWriter:

	slicer = None
	
	def ensureDirectory(lock, directory):

		lock.acquire()
		try:

			if not os.path.exists('temp'):
				os.makedirs('temp')

			if not os.path.exists('output'):
				os.makedirs('output')

			os.makedirs(directory, exist_ok=True)

		finally:
			lock.release()

		return directory

	@staticmethod
	def addMetadata(lock, path, file, name, description, format, bounds, center, minZoom, maxZoom, profile="mercator", tileSize=256, source=None):

		FileWriter.ensureDirectory(lock, path)

		bounds = list(bounds)
		metadataPath = os.path.join(path, "metadata.json")

		# A folder can collect several downloads; widen the bounds and zoom range to cover them all
		lock.acquire()
		try:
			existing = {}
			if os.path.isfile(metadataPath):
				try:
					with open(metadataPath) as jsonFile:
						existing = json.load(jsonFile)
				except (ValueError, OSError):
					existing = {}

			try:
				previous = [float(v) for v in existing["bounds"].split(",")]
				bounds = [min(bounds[0], previous[0]), min(bounds[1], previous[1]), max(bounds[2], previous[2]), max(bounds[3], previous[3])]
				minZoom = min(minZoom, int(existing["minzoom"]))
				maxZoom = max(maxZoom, int(existing["maxzoom"]))
			except (KeyError, ValueError, IndexError):
				pass

			center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, maxZoom]

			data = [
				("name", name),
				("description", description),
				("source", source or existing.get("source", "")),
				("format", format),
				("bounds", ','.join(map(str, bounds))),
				("center", ','.join(map(str, center))),
				("minzoom", minZoom),
				("maxzoom", maxZoom),
				("profile", profile),
				("tilesize", str(tileSize)),
				("scheme", "xyz"),
				("generator", "EliteMapper by Visor Dynamics"),
				("type", "overlay"),
				("attribution", "EliteMapper by Visor Dynamics"),
			]

			with open(metadataPath, 'w') as jsonFile:
				json.dump(dict(data), jsonFile, indent=1)
		finally:
			lock.release()

		return

	@staticmethod
	def addTile(lock, filePath, sourcePath, x, y, z, outputScale):

		fileDirectory = os.path.dirname(filePath)
		FileWriter.ensureDirectory(lock, fileDirectory)
		
		shutil.copyfile(sourcePath, filePath)

		return

	@staticmethod
	def exists(filePath, x, y, z):
		return os.path.isfile(filePath)


	@staticmethod
	def close(lock, path, file, minZoom, maxZoom):
		#TODO recalculate bounds and center
		return