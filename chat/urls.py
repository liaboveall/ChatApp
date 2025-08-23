from django.contrib import admin
from django.urls import path, include
from . import views as chat_views

urlpatterns = [
    path('', chat_views.chat_home, name='chat-home'),
    path('online-users/', chat_views.online_users, name='online-users'),
    # 先匹配更具体的私聊路由，避免被下面的通配符捕获
    path('chat/private-chat/<int:chat_id>/', chat_views.private_chat, name='private-chat'),
    path('chat/<str:room_name>/', chat_views.chat_room, name='chat-room'),
    path('create-room/', chat_views.create_room, name='create-room'),
    path('join/<slug:room_slug>/', chat_views.join_private_room, name='join-private-room'),
    path('my-private-chats/', chat_views.my_private_chats, name='my-private-chats'),
    path('ai-chat/', chat_views.ai_chat, name='ai-chat'),
    path('check-room-name/', chat_views.check_room_name, name='check-room-name'),
]
