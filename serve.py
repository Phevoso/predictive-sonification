# Local server that disables caching, so edited modules are always reloaded.
# Usage: python3 serve.py [port], then open http://localhost:8030/demo/
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8030
http.server.ThreadingHTTPServer(('', port), NoCache).serve_forever()
