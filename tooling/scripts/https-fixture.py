import http.server, ssl, os
os.chdir(os.path.join(os.path.dirname(__file__), '..', 'fixtures'))
server=http.server.ThreadingHTTPServer(('0.0.0.0',8443),http.server.SimpleHTTPRequestHandler)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('cert/cert.pem','cert/key.pem')
server.socket=context.wrap_socket(server.socket,server_side=True)
server.serve_forever()
