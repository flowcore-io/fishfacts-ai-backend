# /// script
# requires-python = "==3.14.*"
# dependencies = ["pyogrio==0.13.0", "geopandas==1.1.3", "shapely==2.1.2", "pyproj==3.8.0"]
# ///
"""Prepare reference data only; never downloads or connects to application databases.
Run: uv run --python 3.14.4 scripts/coastal/prepare-land.py --help
The coverage rectangle is a dataset boundary, not a legal latitude policy.
"""
import argparse, hashlib, json, platform, zipfile
from pathlib import Path
import geopandas, pyogrio, pyproj, shapely
from shapely.geometry import box, mapping


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def normalized(value):
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, (list, tuple)):
        return [normalized(v) for v in value]
    if isinstance(value, dict):
        return {k: normalized(v) for k, v in value.items()}
    return value


def canonical(value):
    return json.dumps(normalized(value), sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--archive', type=Path, required=True, help='Local original complete OSM land ZIP; no runtime downloads')
p.add_argument('--archive-sha256', required=True)
p.add_argument('--output', type=Path, required=True, help='NEW local directory outside git; refuse overwriting an artifact')
p.add_argument('--coverage', type=float, nargs=4, required=True, metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'))
a = p.parse_args()
if a.output.exists():
    p.error('output already exists; preserve immutable original artifact')
w, s, e, n = a.coverage
if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
    p.error('invalid WGS84 coverage rectangle')
if digest(a.archive) != a.archive_sha256:
    p.error('original archive checksum mismatch')
with zipfile.ZipFile(a.archive) as z:
    readme = z.read('land-polygons-complete-4326/README.txt').decode('utf8')
    import re
    date = re.search(r'Date of the data used is ([^\s]+)', readme)
    if not date:
        p.error('original archive has no data date')
frame = box(w, s, e, n)
data = pyogrio.read_dataframe(f'zip://{a.archive.resolve()}!land-polygons-complete-4326/land_polygons.shp', bbox=tuple(a.coverage), fid_as_index=True)
a.output.mkdir(parents=True)
extract = a.output / 'land.ndjson'
count = coordinates = 0
with extract.open('w', encoding='utf8', newline='\n') as f:
    for fid, g in data.geometry.sort_index().items():
        if not g.is_valid:
            raise ValueError(f'invalid original polygon {fid}; no repair permitted')
        clipped = g.intersection(frame)
        if clipped.is_empty:
            continue
        if not clipped.is_valid or clipped.geom_type not in ('Polygon', 'MultiPolygon'):
            raise ValueError(f'invalid/nonpolygon clipped feature {fid}')
        # Keep the extract row field order explicit, matching the measured artifact.
        f.write(json.dumps({'sourceFid': int(fid), 'wkbHex': shapely.to_wkb(clipped, byte_order=1).hex()}, separators=(',', ':')) + '\n')
        count += 1
        coordinates += int(shapely.get_num_coordinates(clipped))
manifest = {
    'version': 1, 'archiveSha256': a.archive_sha256, 'extractSha256': digest(extract),
    'extractBytes': extract.stat().st_size, 'features': count, 'coordinates': coordinates,
    'coverage': normalized(mapping(frame)), 'crs': 'EPSG:4326', 'dataDate': date[1],
    'sourceUrl': 'https://osmdata.openstreetmap.de/download/land-polygons-complete-4326.zip',
    'sourceReadme': readme, 'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors',
    'copyrightUrl': 'https://www.openstreetmap.org/copyright',
    'tools': {'python': platform.python_version(), 'geopandas': geopandas.__version__, 'pyogrio': pyogrio.__version__, 'gdal': pyogrio.__gdal_version_string__, 'shapely': shapely.__version__, 'geos': shapely.geos_version_string, 'pyproj': pyproj.__version__},
    'preparationScriptSha256': digest(Path(__file__)),
    'preparation': 'FID-sorted complete land, exact coverage intersection, little-endian 2D WKB; no repair, simplify, buffer, snap or precision reduction',
    'command': f'uv run --python 3.14.4 scripts/coastal/prepare-land.py --archive <original.zip> --archive-sha256 {a.archive_sha256} --output <new-directory> --coverage {w:g} {s:g} {e:g} {n:g}',
}
manifest['datasetId'] = 'osm-land-v1-' + hashlib.sha256(canonical(manifest).encode('utf8')).hexdigest()
(a.output / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
print(json.dumps({'datasetId': manifest['datasetId'], 'features': count, 'extractSha256': manifest['extractSha256']}))
