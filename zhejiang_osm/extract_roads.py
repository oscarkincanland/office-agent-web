"""Extract Zhejiang road network from OSM PBF (2 streaming passes, pyosmium).

Outputs in zhejiang_osm/:
  - zhejiang_roads.geojson  all highway=* ways, full tags, WGS84 LineStrings
  - zhejiang_nodes.csv      node_id,lon,lat for nodes referenced by roads
  - zhejiang_edges.csv      routable edge list: u,v,length_m,speed_kph,
                            travel_time_s,highway,oneway,name
"""
import csv, json, re, time
from math import radians, sin, cos, atan2, sqrt
import osmium

SRC = "zhejiang_osm/zhejiang-latest.osm.pbf"
OUT = "zhejiang_osm"

FALLBACK_SPEED = {  # km/h when maxspeed absent
    "motorway": 100, "motorway_link": 60, "trunk": 90, "trunk_link": 50,
    "primary": 70, "primary_link": 40, "secondary": 55, "secondary_link": 35,
    "tertiary": 45, "tertiary_link": 30, "unclassified": 35, "residential": 30,
    "living_street": 15, "service": 20, "road": 35,
}
ONEWAY_TAGS = {"yes", "1", "true", "-1", "reverse"}
MPH = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*mph\s*$", re.I)
NUM = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:km/?h|kph)?\s*$", re.I)


def haversine(a, b):
    """Distance in meters between two osmium Locations."""
    la1, lo1, la2, lo2 = map(radians, (a.lat, a.lon, b.lat, b.lon))
    dla, dlo = la2 - la1, lo2 - lo1
    x = sin(dla / 2) ** 2 + cos(la1) * cos(la2) * sin(dlo / 2) ** 2
    return 2 * 6371000 * atan2(sqrt(x), sqrt(1 - x))


def parse_speed(v):
    """maxspeed tag -> km/h or None."""
    if v is None:
        return None
    v = str(v).strip().lower()
    if v == "walk":
        return 5.0
    m = MPH.match(v)
    if m:
        return float(m.group(1)) * 1.60934
    m = NUM.match(v)
    if m:
        return float(m.group(1))
    return None


class RoadIdCollector(osmium.SimpleHandler):
    """Pass 1: node ids referenced by highway ways."""
    def __init__(self):
        super().__init__()
        self.node_ids = osmium.index.IdSet()
        self.n_ways = 0

    def way(self, w):
        if w.tags.get("highway"):
            self.n_ways += 1
            for n in w.nodes:
                self.node_ids.set(n.ref)


class Exporter(osmium.SimpleHandler):
    """Pass 2 with locations: GeoJSON features + node CSV + edge CSV."""
    def __init__(self, node_ids):
        super().__init__()
        self.node_ids = node_ids
        self.gf = osmium.geom.GeoJSONFactory()
        self.fj = open(f"{OUT}/zhejiang_roads.geojson", "w", encoding="utf-8")
        self.fj.write('{"type":"FeatureCollection","features":[')
        self._first = True
        self.f_nodes = open(f"{OUT}/zhejiang_nodes.csv", "w", newline="")
        self.w_nodes = csv.writer(self.f_nodes)
        self.w_nodes.writerow(["node_id", "lon", "lat"])
        self.f_edges = open(f"{OUT}/zhejiang_edges.csv", "w", newline="")
        self.w_edges = csv.writer(self.f_edges)
        self.w_edges.writerow(["u", "v", "length_m", "speed_kph",
                               "travel_time_s", "highway", "oneway", "name"])
        self.n_features = 0
        self.n_nodes_out = 0
        self.n_edges_out = 0
        self._seen_nodes = osmium.index.IdSet()

    def node(self, n):
        if n.id in self.node_ids and n.id not in self._seen_nodes:
            self._seen_nodes.set(n.id)
            self.w_nodes.writerow([n.id, f"{n.location.lon:.7f}",
                                   f"{n.location.lat:.7f}"])
            self.n_nodes_out += 1

    def way(self, w):
        hw = w.tags.get("highway")
        if not hw or hw == "raceway":
            return
        try:
            geom = json.loads(self.gf.create_linestring(w))
        except osmium.InvalidLocationError:
            return
        props = {k: v for k, v in w.tags}
        feat = {"type": "Feature", "id": w.id,
                "properties": props, "geometry": geom}
        if not self._first:
            self.fj.write(",")
        json.dump(feat, self.fj, ensure_ascii=False, separators=(",", ":"))
        self._first = False
        self.n_features += 1

        ms = parse_speed(w.tags.get("maxspeed"))
        speed = ms or FALLBACK_SPEED.get(hw, 30)
        oneway = (w.tags.get("oneway") in ONEWAY_TAGS
                  or w.tags.get("junction") == "roundabout")
        name = w.tags.get("name") or ""
        prev_id, prev_loc = None, None
        for n in w.nodes:
            if not n.location.valid():
                prev_id = prev_loc = None  # gap outside extract
                continue
            loc = n.location
            if prev_id is not None:
                d = haversine(prev_loc, loc)
                self.w_edges.writerow([prev_id, n.ref, f"{d:.2f}",
                                       f"{speed:.1f}", f"{d/(speed/3.6):.2f}",
                                       hw, int(oneway), name])
                self.n_edges_out += 1
            prev_id, prev_loc = n.ref, loc

    def close(self):
        self.fj.write("]}\n")
        self.fj.close()
        self.f_nodes.close()
        self.f_edges.close()


def main():
    t0 = time.time()
    print(f"[1/2] collecting highway node ids from {SRC} ...", flush=True)
    col = RoadIdCollector()
    col.apply_file(SRC)
    print(f"      highway ways={col.n_ways} node ids={len(col.node_ids)} "
          f"({time.time()-t0:.0f}s)", flush=True)

    print("[2/2] exporting geojson + nodes + edges (locations=True) ...",
          flush=True)
    exp = Exporter(col.node_ids)
    exp.apply_file(SRC, locations=True)
    exp.close()
    print(f"      ways={exp.n_features} nodes={exp.n_nodes_out} "
          f"edges={exp.n_edges_out} ({time.time()-t0:.0f}s)", flush=True)
    print(f"ALL DONE in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
