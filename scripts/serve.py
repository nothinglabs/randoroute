#!/usr/bin/env python3
"""Static development server with HTTP byte-range support for PMTiles.

Usage: python3 scripts/serve.py [--port 8000]
"""
import argparse
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    """Serve files normally, or satisfy a single RFC 7233 byte range."""

    range = None

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, 'File not found')
            return None
        size = os.fstat(f.fileno()).st_size
        content_type = self.guess_type(path)
        header = self.headers.get('Range')
        if not header or not header.startswith('bytes='):
            self.send_response(200)
            self.send_header('Content-type', content_type)
            self.send_header('Content-Length', str(size))
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            self.range = None
            return f
        try:
            start_text, end_text = header.removeprefix('bytes=').split('-', 1)
            start = int(start_text) if start_text else 0
            end = int(end_text) if end_text else size - 1
            start = max(0, start)
            end = min(size - 1, end)
            if start > end:
                raise ValueError
        except ValueError:
            f.close()
            self.send_error(416, 'Invalid byte range')
            return None
        self.send_response(206)
        self.send_header('Content-type', content_type)
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        f.seek(start)
        self.range = end - start + 1
        return f

    def copyfile(self, source, output):
        if self.range is None:
            return super().copyfile(source, output)
        remaining = self.range
        while remaining:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            output.write(chunk)
            remaining -= len(chunk)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    with ThreadingHTTPServer(('', args.port), RangeHandler) as server:
        print(f'Serving with byte-range support at http://127.0.0.1:{args.port}/')
        server.serve_forever()
