import json
import base64
from mitmproxy import http, ctx

def running():
    ctx.options.ssl_insecure = True  # don't verify upstream certs

def _encode_body(content: bytes, headers) -> dict:
    if not content:
        return {}
    try:
        return {"body": content.decode("utf-8"), "is_binary": False}
    except UnicodeDecodeError:
        return {
            "body": base64.b64encode(content).decode("utf-8"),
            "is_binary": True,
            "mime_type": headers.get("content-type", "application/octet-stream"),
        }

class Bridge:
    def responseheaders(self, flow: http.HTTPFlow):
        """Stream SSE and WebSocket — these never complete so buffering hangs."""
        ct = flow.response.headers.get("content-type", "").lower()
        if "text/event-stream" in ct or flow.response.status_code == 101:
            flow.response.stream = True

    def response(self, flow: http.HTTPFlow):
        if flow.response is None:
            return

        # Use .content which gives decoded body (decompressed)
        # for our inspector display
        req_body = flow.request.content or b""
        resp_body = flow.response.content or b""

        payload = {
            "id": flow.id,
            "request": {
                "method": flow.request.method,
                "url": flow.request.pretty_url,
                "headers": dict(flow.request.headers),
                "timestamp_start": flow.request.timestamp_start,
                "mime_type": flow.request.headers.get("content-type"),
                **_encode_body(req_body, flow.request.headers),
            },
            "response": {
                "status_code": flow.response.status_code,
                "headers": dict(flow.response.headers),
                "timestamp_start": getattr(flow.response, "timestamp_start", None),
                "timestamp_end": getattr(flow.response, "timestamp_end", None),
                "mime_type": flow.response.headers.get("content-type"),
                "content_length": len(resp_body),
                **_encode_body(resp_body, flow.response.headers),
            },
        }

        print(json.dumps(payload), flush=True)

        # DO NOT clear flow.request.content or flow.response.content here!
        # The response() hook fires BEFORE mitmproxy sends the response
        # to the client. Clearing content would send an empty body.

addons = [Bridge()]
