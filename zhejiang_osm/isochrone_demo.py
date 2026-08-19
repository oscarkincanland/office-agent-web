"""Demo: driving isochrone from West Lake (Hangzhou) using extracted data.

Caches Dijkstra result to pickle; renders with LineCollection (fast).
Output: zhejiang_osm/isochrone_demo.png + isochrone_reachable.geojson
"""
import csv, json, os, pickle, time
import networkx as nx

EDGES = "zhejiang_osm/zhejiang_edges.csv"
NODES = "zhejiang_osm/zhejiang_nodes.csv"
OUT = "zhejiang_osm"
ORIGIN = (120.1486, 30.2505)  # West Lake, Hangzhou
TIMES = [1800, 3600]
CACHE = f"{OUT}/_dijkstra_cache.pkl"
DRIVE_HW = {"motorway", "motorway_link", "trunk", "trunk_link", "primary",
            "primary_link", "secondary", "secondary_link", "tertiary",
            "tertiary_link", "unclassified", "residential", "living_street",
            "service", "road"}
BASEMAP_HW = {"motorway", "trunk", "primary", "secondary", "tertiary"}


def nearest_node(G, x, y, coords):
    return min(G.nodes, key=lambda n: (coords[n][0] - x) ** 2
               + (coords[n][1] - y) ** 2)


def compute():
    t0 = time.time()
    coords = {}
    with open(NODES) as f:
        for row in csv.DictReader(f):
            coords[int(row["node_id"])] = (float(row["lon"]), float(row["lat"]))
    print(f"  coords: {len(coords)} ({time.time()-t0:.0f}s)", flush=True)

    G = nx.MultiDiGraph()
    with open(EDGES) as f:
        for row in csv.DictReader(f):
            if row["highway"] not in DRIVE_HW:
                continue
            u, v = int(row["u"]), int(row["v"])
            if u not in coords or v not in coords:
                continue
            t, d = float(row["travel_time_s"]), float(row["length_m"])
            G.add_edge(u, v, length=d, travel_time=t)
            if row["oneway"] == "0":
                G.add_edge(v, u, length=d, travel_time=t)
    print(f"  drive graph: {G.number_of_nodes()} nodes / "
          f"{G.number_of_edges()} edges ({time.time()-t0:.0f}s)", flush=True)

    o = nearest_node(G, ORIGIN[0], ORIGIN[1], coords)
    print(f"  origin node {o} at {coords[o]}", flush=True)
    dist = nx.single_source_dijkstra_path_length(G, o, weight="travel_time",
                                                 cutoff=TIMES[-1])
    print(f"  reached {len(dist)} nodes ({time.time()-t0:.0f}s)", flush=True)
    with open(CACHE, "wb") as f:
        pickle.dump({"dist": dist, "coords": coords}, f)
    print(f"  cached to {CACHE}", flush=True)


def render():
    t0 = time.time()
    with open(CACHE, "rb") as f:
        data = pickle.load(f)
    dist, coords = data["dist"], data["coords"]
    print(f"  cache loaded ({time.time()-t0:.0f}s)", flush=True)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    # view box: Hangzhou metro area
    bbox = (119.55, 120.85, 29.65, 30.85)

    fig, ax = plt.subplots(figsize=(12, 10))

    # basemap: major roads only, clipped to bbox, drawn as LineCollections
    print("  basemap: reading road geojson ...", flush=True)
    segs_by_hw = {hw: [] for hw in BASEMAP_HW}
    with open(f"{OUT}/zhejiang_roads.geojson") as f:
        for feat in json.load(f)["features"]:
            hw = feat["properties"].get("highway")
            if hw not in segs_by_hw:
                continue
            line = feat["geometry"]["coordinates"]
            if not any(bbox[0] <= c[0] <= bbox[1] and bbox[2] <= c[1] <= bbox[3]
                       for c in line):
                continue
            segs_by_hw[hw].extend(zip(line[:-1], line[1:]))
    n_base = sum(len(v) for v in segs_by_hw.values())
    print(f"  basemap segments in view: {n_base} ({time.time()-t0:.0f}s)",
          flush=True)
    for hw, segs in segs_by_hw.items():
        if segs:
            ax.add_collection(LineCollection(segs, colors="#d9d9d9",
                                             linewidths=0.4, zorder=1))
    # reachable edges per band, scanned once from edge CSV, bbox-clipped
    colors = {3600: "#3498db", 1800: "#e74c3c"}
    segs = {T: [] for T in TIMES}
    with open(EDGES) as f:
        for row in csv.DictReader(f):
            if row["highway"] not in DRIVE_HW:
                continue
            u, v = int(row["u"]), int(row["v"])
            tu, tv = dist.get(u), dist.get(v)
            if tu is None or tv is None:
                continue
            T = max(tu, tv)
            if T > TIMES[-1]:
                continue
            cu, cv = coords[u], coords[v]
            if not ((bbox[0] <= cu[0] <= bbox[1]
                     and bbox[2] <= cu[1] <= bbox[3])
                    or (bbox[0] <= cv[0] <= bbox[1]
                        and bbox[2] <= cv[1] <= bbox[3])):
                continue
            for B in TIMES:
                if T <= B:
                    segs[B].append((cu, cv))
    for T in sorted(TIMES, reverse=True):
        ax.add_collection(LineCollection(segs[T], colors=colors[T],
                                         linewidths=0.35, alpha=0.8,
                                         zorder=2))
        print(f"  band <= {T//60} min: {len(segs[T])} segments "
              f"({time.time()-t0:.0f}s)", flush=True)

    ax.plot(ORIGIN[0], ORIGIN[1], "k^", markersize=12, zorder=5)
    ax.set_xlim(bbox[0], bbox[1]); ax.set_ylim(bbox[2], bbox[3])
    ax.set_title("Driving reachability from West Lake, Hangzhou\n"
                 "red = 30 min, blue = 60 min (OSM static speeds)")
    ax.set_aspect("equal")
    fig.savefig(f"{OUT}/isochrone_demo.png", dpi=120, bbox_inches="tight")
    print(f"  saved {OUT}/isochrone_demo.png ({time.time()-t0:.0f}s)",
          flush=True)


def geojson():
    """Compact reachable-edge GeoJSON using edge CSV + dist cache."""
    t0 = time.time()
    with open(CACHE, "rb") as f:
        data = pickle.load(f)
    dist, coords = data["dist"], data["coords"]
    n_feat = 0
    with open(f"{OUT}/isochrone_reachable.geojson", "w") as out, \
            open(EDGES) as f:
        out.write('{"type":"FeatureCollection","features":[')
        first = True
        for row in csv.DictReader(f):
            if row["highway"] not in DRIVE_HW:
                continue
            u, v = int(row["u"]), int(row["v"])
            if u not in dist or v not in dist:
                continue
            T = max(dist[u], dist[v])
            if T > TIMES[-1]:
                continue
            cu, cv = coords.get(u), coords.get(v)
            if cu is None or cv is None:
                continue
            feat = {"type": "Feature",
                    "properties": {"min": round(T / 60, 1),
                                   "hw": row["highway"]},
                    "geometry": {"type": "LineString",
                                 "coordinates": [list(cu), list(cv)]}}
            if not first:
                out.write(",")
            json.dump(feat, out, separators=(",", ":"))
            first = False
            n_feat += 1
        out.write("]}\n")
    print(f"  geojson: {n_feat} features ({time.time()-t0:.0f}s)", flush=True)


def main():
    if not os.path.exists(CACHE):
        print("[1] Dijkstra ...", flush=True)
        compute()
    else:
        print("[1] using Dijkstra cache", flush=True)
    print("[2] rendering ...", flush=True)
    render()
    print("[3] reachable geojson ...", flush=True)
    geojson()
    print("ALL DONE", flush=True)


if __name__ == "__main__":
    main()
