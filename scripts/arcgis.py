#!/usr/bin/env python3
"""
Shared paging client for the ArcGIS REST services the build steps read.

BUILD-TIME ONLY. The app never calls these services; it renders from the static
files these scripts produce.

Every source we import is an ArcGIS FeatureServer or MapServer layer with a
2,000-row page limit, so all three fetchers need the same loop: page by
resultOffset with a stable sort, retry on transport errors, and cache each page
to disk so a re-run after a failure does not start over.
"""
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT_S = 120
RETRIES = 5
# Some agency ArcGIS deployments reject urllib's default `Python-urllib/3.x`
# with a flat 403 while serving the identical URL to a browser string. Southern
# Nevada's is one, and the failure looks like a permissions problem on a public
# open-data service rather than a header the client did not send.
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; randoroute-build/1.0)"}


def _get(url, params, retries=RETRIES):
    """One request, with backoff. ArcGIS returns HTTP 200 on errors, so the
    JSON body has to be checked too."""
    query = urllib.parse.urlencode(params)
    delay = 2
    last = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(f"{url}?{query}", headers=HEADERS)
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as r:
                body = json.load(r)
            if isinstance(body, dict) and "error" in body:
                raise RuntimeError(f"service error: {body['error']}")
            return body
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as e:
            last = e
            if attempt == retries - 1:
                break
            time.sleep(delay)
            delay = min(delay * 2, 30)
    raise RuntimeError(f"{url} failed after {retries} attempts: {last}")


def layer_info(layer_url):
    return _get(layer_url, {"f": "json"})


def count(layer_url, where="1=1"):
    body = _get(layer_url + "/query",
                {"where": where, "returnCountOnly": "true", "f": "json"})
    return body.get("count", 0)


def fetch_all(layer_url, fields, where="1=1", out_sr=4326, page=1000,
              order_by="OBJECTID", cache_dir=None, geometry=True, label=""):
    """Yield every feature of a layer, paging by resultOffset.

    A stable `order_by` is required: without it the service is free to return
    rows in a different order per page and paging silently drops and duplicates
    records. Pages are cached under `cache_dir` so an interrupted run resumes.

    The cache file name carries a digest of the layer URL, the filter and the
    field list, because a page name of `0000000.json` alone belongs to whichever
    layer wrote it first. An adapter that reads several layers of one service
    into one cache directory -- which is the natural way to write one, and how
    Nevada's found this -- then served every later layer the FIRST layer's rows.
    Silently: the attributes are simply the wrong ones, and the row-count guard
    below cannot see it, because a big layer's pages overfill a small layer's
    total and `got` ends up LARGER than `total`. The visible symptom was an
    empty output file, which reads exactly like "the state does not publish
    this".
    """
    total = count(layer_url, where)
    if label:
        print(f"  {label}: {total:,} features", flush=True)
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
    key = hashlib.sha1(
        f"{layer_url}|{where}|{','.join(fields)}|{out_sr}|{order_by}"
        .encode()).hexdigest()[:8]
    got = 0
    offset = 0
    while offset < total:
        cache_path = (os.path.join(cache_dir, f"{key}-{offset:07d}.json")
                      if cache_dir else None)
        body = None
        if cache_path and os.path.exists(cache_path):
            try:
                with open(cache_path) as fh:
                    body = json.load(fh)
            except (ValueError, OSError):
                body = None  # truncated by an interrupted run; refetch
        if body is None:
            params = {
                "where": where,
                "outFields": ",".join(fields),
                "returnGeometry": "true" if geometry else "false",
                "outSR": out_sr,
                "resultOffset": offset,
                "resultRecordCount": page,
                "orderByFields": order_by,
                "f": "json",
            }
            body = _get(layer_url + "/query", params)
            if cache_path:
                tmp = cache_path + ".part"
                with open(tmp, "w") as fh:
                    json.dump(body, fh)
                os.replace(tmp, cache_path)
        features = body.get("features", [])
        if not features:
            break
        for f in features:
            yield f
        got += len(features)
        offset += len(features)
        if label and (offset % (page * 10) == 0 or offset >= total):
            print(f"    {offset:,} / {total:,}", flush=True)
    if got < total:
        raise RuntimeError(
            f"{label or layer_url}: expected {total:,} features, got {got:,}")


def paths_of(geom, decimals=5):
    """ArcGIS polyline geometry -> list of coordinate rings, rounded.

    Returns [] for anything that is not a usable polyline so callers can skip
    it rather than guard every access.
    """
    if not isinstance(geom, dict):
        return []
    out = []
    for path in geom.get("paths") or []:
        ring = [[round(float(pt[0]), decimals), round(float(pt[1]), decimals)]
                for pt in path if pt and len(pt) >= 2]
        # Collapse repeated vertices; the sources contain many.
        dedup = [ring[0]] if ring else []
        for pt in ring[1:]:
            if pt != dedup[-1]:
                dedup.append(pt)
        if len(dedup) >= 2:
            out.append(dedup)
    return out


def num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f  # NaN


def text(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None
