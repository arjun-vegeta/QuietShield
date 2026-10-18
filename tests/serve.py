# HTTPS static server for tests/pages (self-signed; browsers run with --ignore-certificate-errors).
import http.server, ssl, sys, os
os.chdir(os.path.join(os.path.dirname(__file__), 'pages'))
host, port, cert, key = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
httpd = http.server.ThreadingHTTPServer((host, port), http.server.SimpleHTTPRequestHandler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
httpd.serve_forever()
