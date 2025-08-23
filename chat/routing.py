"""
This file is for routing to the consumer
"""
from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r'ws/chat/(?P<room_name>\w+)/$', consumers.ChatConsumer.as_asgi()),
    re_path(r'ws/chat/online-users/$', consumers.OnlineStatusConsumer.as_asgi()),
    re_path(r'ws/private-chat/(?P<room_name>[\w-]+)/$', consumers.PrivateChatConsumer.as_asgi()),
    re_path(r'ws/ai-chat/(?P<room_name>\w+)/$', consumers.AIBotConsumer.as_asgi()),
]
