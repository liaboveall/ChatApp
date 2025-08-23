"""Project-level websocket routing re-export.

To avoid duplication and naming drift, reuse chat.routing.websocket_urlpatterns.
"""
from chat.routing import websocket_urlpatterns  # noqa: F401 re-export for ASGI