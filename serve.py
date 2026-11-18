"""Serve this folder at http://localhost:8080 (python serve.py [port]).

Sends the cross-origin isolation headers so the Rive runtime can use threads.
"""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.riv': 'application/octet-stream', '.wasm': 'application/wasm',
                      '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    print('Sky Battle on http://localhost:%d' % PORT)
    http.server.ThreadingHTTPServer(('', PORT), Handler).serve_forever()
