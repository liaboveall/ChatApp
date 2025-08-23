import json
import base64
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.core.files.base import ContentFile
from django.conf import settings
import os
from .models import Message
from django.utils import timezone
from openai import OpenAI
import asyncio
import uuid
from django.contrib.auth.models import User
from typing import Any


def require_channel_layer(consumer: AsyncWebsocketConsumer) -> Any:
    """Ensure channel_layer exists; helpful for type checkers and runtime safety."""
    layer = consumer.channel_layer
    if layer is None:
        raise RuntimeError("Channel layer not configured. Check CHANNEL_LAYERS in settings.")
    return layer

class ChatConsumer(AsyncWebsocketConsumer):
    """
    A consumer does three things:
    1. Accepts connections.
    2. Receives messages from client.
    3. Disconnects when the job is done.
    """

    async def connect(self):
        """
        Connect to a room
        """
        user = self.scope['user']

        if user.is_authenticated:
            self.room_name = self.scope['url_route']['kwargs']['room_name']
            # 使用 room_name 的 ASCII 安全版本作为群组名
            self.room_group_name = f"chat_{self.room_name.replace(' ', '_').encode('ascii', 'ignore').decode()}"

            # Join room group
            layer = require_channel_layer(self)
            await layer.group_add(
                self.room_group_name,
                self.channel_name
            )
            await self.accept()
            print(f"User {user.username} connected to room {self.room_name}")
        else:
            await self.close()

    async def disconnect(self, close_code):
        """
        Disconnect from channel

        :param close_code: optional
        """
        layer = require_channel_layer(self)
        await layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    async def receive(self, text_data):
        """
        Receive messages from WebSocket

        :param text_data: message
        """

        data = json.loads(text_data)
        message_type = data.get('type')

        if message_type == 'delete_message':
            await self.handle_delete_message(data)
        elif message_type == 'recall_message':
            await self.handle_recall_message(data)
        elif message_type in ['image', 'video', 'file']:
            await self.handle_file_message(data)
        else:
            # 处理文本消息
            message = data['message']
            username = data['username']
            room = data['room']
            profile_pic = data.get('profile_pic', '')

            # 保存消息到数据库
            saved_message = await self.save_message(
                username=username,
                room=room,
                message_type='text',
                message_content=message,
                profile_pic=profile_pic
            )

            if saved_message:
                layer = require_channel_layer(self)
                await layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'chat_message',
                        'message': message,
                        'username': username,
                        'profile_pic': profile_pic,
                        'message_id': saved_message.id,
                        'message_type': 'text'
                    }
                )

    async def handle_delete_message(self, data):
        message_id = data.get('message_id')
        user = self.scope['user']
        
        # 删除消息
        success = await self.delete_message(message_id, user)
        if success:
            # 通知所有用户消息已删除
            layer = require_channel_layer(self)
            await layer.group_send(
                self.room_group_name,
                {
                    'type': 'message_deleted',
                    'message_id': message_id
                }
            )

    async def handle_recall_message(self, data):
        message_id = data.get('message_id')
        user = self.scope['user']
        
        # 撤回消息
        success = await self.recall_message(message_id, user)
        if success:
            # 通知所有用户消息已撤回
            layer = require_channel_layer(self)
            await layer.group_send(
                self.room_group_name,
                {
                    'type': 'message_recalled',
                    'message_id': message_id
                }
            )

    async def message_deleted(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_deleted',
            'message_id': event['message_id']
        }))

    async def message_recalled(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_recalled',
            'message_id': event['message_id']
        }))

    async def delete_message(self, message_id, user):
        def _op():
            try:
                message = Message.objects.get(id=message_id, username=user.username)
                message.is_deleted = True
                message.save()
                return True
            except Message.DoesNotExist:
                return False
        return await database_sync_to_async(_op)()

    async def recall_message(self, message_id, user):
        def _op():
            try:
                message = Message.objects.get(
                    id=message_id,
                    username=user.username,
                    date_added__gte=timezone.now() - timezone.timedelta(minutes=2)
                )
                message.is_recalled = True
                message.recall_time = timezone.now()
                message.save()
                return True
            except Message.DoesNotExist:
                return False
        return await database_sync_to_async(_op)()

    async def chat_message(self, event):
        """
        Receive messages from room group
        """
        await self.send(text_data=json.dumps({
            'type': event['message_type'],
            'message': event.get('message'),
            'username': event['username'],
            'profile_pic': event['profile_pic'],
            'message_id': event.get('message_id'),
            'file_url': event.get('file_url'),
            'file_name': event.get('file_name')
        }))

    async def save_message(self, username, room, message_type='text', message_content=None, file=None, file_name=None, profile_pic=None):
        """保存消息到数据库"""
        def _create():
            try:
                user = User.objects.filter(username=username).first()
                message = Message.objects.create(
                    username=username,
                    user=user,
                    room=room,
                    message_type=message_type,
                    message_content=message_content,
                    file=file,
                    file_name=file_name,
                    profile_pic=profile_pic or ''
                )
                return message
            except Exception as e:
                print(f"Error saving message: {e}")
                return None
        message = await database_sync_to_async(_create)()
        if message:
            print(f"Message saved: {message.id} in room {room}")
        return message

    async def handle_file_message(self, data):
        """处理文件类型消息"""
        try:
            file_data = data['file'].split(';base64,')[1]
            file_content = ContentFile(base64.b64decode(file_data))
            
            # 生成文件路径
            file_name = data['file_name']
            message_type = data['type']
            today = timezone.now()
            
            # 根据消息类型设置存储路径
            if message_type == 'image':
                path = f'chat_files/{today.year}/{today.month:02d}/{today.day:02d}/images/'
            elif message_type == 'video':
                path = f'chat_files/{today.year}/{today.month:02d}/{today.day:02d}/videos/'
            else:
                path = f'chat_files/{today.year}/{today.month:02d}/{today.day:02d}/files/'
            
            # 确保目录存在
            full_path = os.path.join(settings.MEDIA_ROOT, path)
            os.makedirs(full_path, exist_ok=True)
            
            # 生成唯一文件名
            file_extension = os.path.splitext(file_name)[1]
            unique_filename = f"{uuid.uuid4().hex}{file_extension}"
            file_path = f"{path}{unique_filename}"
            
            # 打印完整的文件存储路径
            print(f"===== 文件上传信息 =====")
            print(f"文件类型: {message_type}")
            print(f"原始文件名: {file_name}")
            print(f"存储目录: {full_path}")
            print(f"完整存储路径: {os.path.join(settings.MEDIA_ROOT, file_path)}")
            print(f"访问URL: {settings.MEDIA_URL}{file_path}")
            print("=====================")
            
            # 保存文件
            full_file_path = os.path.join(settings.MEDIA_ROOT, file_path)
            with open(full_file_path, 'wb') as f:
                f.write(base64.b64decode(file_data))
            
            # 保存消息记录
            message = await self.save_message(
                username=data['username'],
                room=self.room_name,
                message_type=message_type,
                file_name=file_name,
                file=file_path,
                profile_pic=data.get('profile_pic', '')
            )
            
            if message:
                print(f"消息保存成功，ID: {message.id}")
                print(f"文件URL: {message.file.url}")
                
                layer = require_channel_layer(self)
                await layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'chat_message',
                        'message_type': message_type,
                        'file_url': message.file.url,
                        'file_name': file_name,
                        'username': data['username'],
                        'profile_pic': data.get('profile_pic', ''),
                        'message_id': message.id
                    }
                )
        except Exception as e:
            print(f"===== 文件处理错误 =====")
            print(f"错误类型: {type(e).__name__}")
            print(f"错误信息: {str(e)}")
            import traceback
            print(f"错误堆栈: \n{traceback.format_exc()}")
            print("=====================")
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': f'文件处理失败: {str(e)}'
            }))

class OnlineStatusConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        print("Attempting to connect to online status")
        await self.accept()
        user = self.scope['user']
        if user.is_authenticated:
            # 将用户添加到自己的私人频道
            layer = require_channel_layer(self)
            await layer.group_add(f'user_{user.id}', self.channel_name)
            await self.update_user_status(user.id, True)
            await layer.group_add('online_users', self.channel_name)
            await self.broadcast_user_status()
            print(f"User {user.username} connected to online status")

    async def disconnect(self, close_code):
        print(f"Disconnecting with code {close_code}")
        user = self.scope['user']
        if user.is_authenticated:
            layer = require_channel_layer(self)
            await layer.group_discard(f'user_{user.id}', self.channel_name)
            await self.update_user_status(user.id, False)
            await layer.group_discard('online_users', self.channel_name)
            await self.broadcast_user_status()
            print(f"User {user.username} disconnected from online status")

    async def chat_request(self, event):
        # 转发私聊请求给客户端
        print(f"Forwarding chat request to client: {event}")
        await self.send(text_data=json.dumps({
            'type': 'chat_request',
            'sender': event['sender'],
            'chat_id': event['chat_id'],
            'is_initiator': event.get('is_initiator', False)
        }))

    async def handle_chat_request(self, data):
        try:
            receiver_id = int(data['receiver_id'])
            print(f"Creating private chat between {self.scope['user'].username} and user {receiver_id}")
            
            chat = await self.create_private_chat(
                self.scope['user'].id,
                receiver_id
            )
            
            if chat:
                print(f"Created private chat: {chat.id}")
                
                # 发送给接收者
                layer = require_channel_layer(self)
                await layer.group_send(
                    f'user_{receiver_id}',
                    {
                        'type': 'chat_request',
                        'sender': self.scope['user'].username,
                        'chat_id': chat.id,
                        'is_initiator': False  # 标记这是发给接收者的消息
                    }
                )
                
                # 发送给发起者
                await self.send(text_data=json.dumps({
                    'type': 'chat_request',
                    'sender': self.scope['user'].username,
                    'chat_id': chat.id,
                    'is_initiator': True  # 标记这是发给发起者的消息
                }))
                
                print(f"Sent chat requests to both users")
            else:
                print("Failed to create private chat")
                await self.send(text_data=json.dumps({
                    'type': 'error',
                    'message': '创建私聊失败'
                }))
        except Exception as e:
            print(f"Error in handle_chat_request: {e}")
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': f'发起私聊时出错: {str(e)}'
            }))

    async def user_status(self, event):
        # 发送用户状态更新到WebSocket
        await self.send(text_data=json.dumps({
            'type': 'user_status',
            'online_users': event['online_users']
        }))

    async def create_private_chat(self, initiator_id, receiver_id):
        from .models import PrivateChat
        from django.contrib.auth.models import User
        
        def _op():
            try:
                user_ids = sorted([initiator_id, receiver_id])
                room_name = f'private_{user_ids[0]}_{user_ids[1]}'
                existing_chat = PrivateChat.objects.filter(
                    room_name=room_name,
                    accepted=True
                ).first()
                if existing_chat:
                    print(f"Found existing active chat: {getattr(existing_chat, 'id', None)}")
                    return existing_chat
                pending_chat = PrivateChat.objects.filter(
                    room_name=room_name,
                    accepted=False
                ).first()
                if pending_chat:
                    print(f"Found pending chat: {getattr(pending_chat, 'id', None)}")
                    return pending_chat
                chat = PrivateChat.objects.create(
                    initiator=User.objects.get(id=initiator_id),
                    receiver=User.objects.get(id=receiver_id),
                    room_name=room_name
                )
                print(f"Created new chat: {getattr(chat, 'id', None)}")
                return chat
            except Exception as e:
                print(f"Error creating private chat: {e}")
                return None
        return await database_sync_to_async(_op)()

    async def update_user_status(self, user_id, status):
        from .models import OnlineUser
        from django.contrib.auth.models import User
        def _op():
            try:
                OnlineUser.objects.filter(user_id=user_id).delete()
                if status:
                    user = User.objects.get(id=user_id)
                    OnlineUser.objects.create(user=user, is_online=True)
            except Exception as e:
                print(f"Error updating user status: {e}")
        await database_sync_to_async(_op)()

    async def broadcast_user_status(self):
        online_users = await self.get_online_users()
        layer = require_channel_layer(self)
        await layer.group_send(
            'online_users',
            {
                'type': 'user_status',
                'online_users': online_users
            }
        )

    async def get_online_users(self):
        from .models import OnlineUser
        current_user = self.scope['user']
        
        def _op():
            online_users = []
            try:
                for online_user in OnlineUser.objects.filter(
                    is_online=True
                ).select_related('user').distinct():
                    try:
                        user = online_user.user
                        online_users.append({
                            'id': user.id,
                            'username': user.username,
                            'is_current': user.id == current_user.id
                        })
                    except Exception as e:
                        print(f"Error getting user data: {e}")
            except Exception as e:
                print(f"Error querying online users: {e}")
            return online_users
        return await database_sync_to_async(_op)()

    async def receive(self, text_data):
        data = json.loads(text_data)
        print(f"Received data: {data}")  # 添加日志
        if data.get('type') == 'chat_request':
            await self.handle_chat_request(data)

class PrivateChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.room_name = self.scope['url_route']['kwargs']['room_name']
        self.room_group_name = f'private_chat_{self.room_name}'
        
        layer = require_channel_layer(self)
        await layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.accept()
        print(f"Connected to private chat room: {self.room_name}")

    async def disconnect(self, close_code):
        layer = require_channel_layer(self)
        await layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    async def receive(self, text_data):
        data = json.loads(text_data)
        message_type = data.get('type')

        if message_type == 'delete_message':
            await self.handle_delete_message(data)
        elif message_type == 'recall_message':
            await self.handle_recall_message(data)
        else:
            await self.handle_chat_message(data)

    async def handle_chat_message(self, data):
        """处理普通聊天消息"""
        message_type = data.get('type', 'text')
        
        if message_type in ['image', 'video', 'file']:
            # 处理文件上传
            file_data = data['file']
            file_name = data['file_name']
            format, filestr = file_data.split(';base64,')
            file_content = ContentFile(base64.b64decode(filestr), name=file_name)
            
            # 保存消息到数据库
            message = await self.save_message(
                username=data['username'],
                room=self.room_name,
                message_type=message_type,
                file=file_content,
                file_name=file_name,
                profile_pic=data.get('profile_pic', '')
            )
            
            # 发送消息到群组
            layer = require_channel_layer(self)
            await layer.group_send(
                self.room_group_name,
                {
                    'type': 'chat_message',
                    'message': None,
                    'username': data['username'],
                    'profile_pic': data.get('profile_pic', ''),
                    'message_type': message_type,
                    'message_id': message.id,
                    'file_url': message.file.url,
                    'file_name': file_name
                }
            )
        else:
            # 处理文本消息
            message = await self.save_message(
                username=data['username'],
                room=self.room_name,
                message_type='text',
                message_content=data.get('message'),
                profile_pic=data.get('profile_pic', '')
            )
            
            layer = require_channel_layer(self)
            await layer.group_send(
                self.room_group_name,
                {
                    'type': 'chat_message',
                    'message': data.get('message'),
                    'username': data['username'],
                    'profile_pic': data.get('profile_pic', ''),
                    'message_type': 'text',
                    'message_id': message.id
                }
            )

    async def handle_delete_message(self, data):
        message_id = data.get('message_id')
        user = self.scope['user']
        
        success = await self.delete_message(message_id, user)
        if success:
            layer = require_channel_layer(self)
            await layer.group_send(
                self.room_group_name,
                {
                    'type': 'message_deleted',
                    'message_id': message_id
                }
            )

    async def handle_recall_message(self, data):
        message_id = data.get('message_id')
        user = self.scope['user']
        
        success = await self.recall_message(message_id, user)
        if success:
            layer = require_channel_layer(self)
            await layer.group_send(
                self.room_group_name,
                {
                    'type': 'message_recalled',
                    'message_id': message_id
                }
            )

    async def message_deleted(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_deleted',
            'message_id': event['message_id']
        }))

    async def message_recalled(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_recalled',
            'message_id': event['message_id']
        }))

    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            'type': event['message_type'],
            'message': event.get('message'),
            'username': event['username'],
            'profile_pic': event.get('profile_pic'),
            'message_id': event.get('message_id'),
            'file_url': event.get('file_url'),
            'file_name': event.get('file_name')
        }))

    async def save_message(self, username, room, message_type='text', message_content=None, file=None, file_name=None, profile_pic=None):
        """保存消息到数据库"""
        def _create():
            try:
                user = User.objects.filter(username=username).first()
                message = Message.objects.create(
                    username=username,
                    user=user,
                    room=room,
                    message_type=message_type,
                    message_content=message_content,
                    file=file,
                    file_name=file_name,
                    profile_pic=profile_pic or ''
                )
                return message
            except Exception as e:
                print(f"Error saving message: {e}")
                return None
        message = await database_sync_to_async(_create)()
        if message:
            print(f"Message saved: {message.id} in room {room}")
        return message

    async def delete_message(self, message_id, user):
        def _op():
            try:
                message = Message.objects.get(id=message_id, username=user.username)
                message.is_deleted = True
                message.save()
                return True
            except Message.DoesNotExist:
                return False
        return await database_sync_to_async(_op)()

    async def recall_message(self, message_id, user):
        def _op():
            try:
                message = Message.objects.get(
                    id=message_id,
                    username=user.username,
                    date_added__gte=timezone.now() - timezone.timedelta(minutes=2)
                )
                message.is_recalled = True
                message.recall_time = timezone.now()
                message.save()
                return True
            except Message.DoesNotExist:
                return False
        return await database_sync_to_async(_op)()

class AIBotConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.message_history = []  # 保存对话历史

    async def connect(self):
        self.room_name = self.scope['url_route']['kwargs']['room_name']
        self.room_group_name = f'ai_chat_{self.room_name}'
        
        layer = require_channel_layer(self)
        await layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.accept()

    async def disconnect(self, close_code):
        layer = require_channel_layer(self)
        await layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    async def receive(self, text_data):
        data = json.loads(text_data)
        message = data.get('message', '')
        
        try:
            # 创建 AI 客户端（从环境变量读取，避免硬编码泄露）
            api_key = os.getenv("OPENAI_API_KEY") or os.getenv("DEEPSEEK_API_KEY")
            base_url = os.getenv("OPENAI_BASE_URL") or os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com/v1"
            if not api_key:
                raise Exception("AI API key 未配置。请设置环境变量 OPENAI_API_KEY 或 DEEPSEEK_API_KEY。")
            client = OpenAI(
                api_key=api_key,
                base_url=base_url
            )
            
            # 保存用户消息到数据库
            user_message = await self.save_message(
                username=data['username'],
                room=self.room_name,
                message_type='text',
                message_content=message,
                profile_pic=data.get('profile_pic', '')
            )
            
            print(f"Processing message: {message}")  # 添加处理日志
            
            # 异步获取 AI 响应
            response = await self.get_ai_response(client, message)
            
            if not response:
                raise Exception("Empty response from AI")
            
            print(f"AI response received: {response}")  # 添加响应日志
            
            # 保存 AI 回复到数据库
            ai_message = await self.save_message(
                username="AI助手",
                room=self.room_name,
                message_type='text',
                message_content=response,
                profile_pic='/media/ai_avatar/ai_avatar.png'
            )
            
            # 发送 AI 回复到群组
            layer = require_channel_layer(self)
            await layer.group_send(
                self.room_group_name,
                {
                    'type': 'chat_message',
                    'message': response,
                    'username': 'AI助手',
                    'profile_pic': '/media/ai_avatar/ai_avatar.png',
                    'message_type': 'text',
                    'message_id': ai_message.id
                }
            )
        except Exception as e:
            print(f"Detailed error in receive: {str(e)}")
            print(f"Error type: {type(e)}")
            import traceback
            print(f"Traceback: {traceback.format_exc()}")
            # 发送错误消息
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': f'AI 助手暂时无法回应: {str(e)}'
            }))

    async def get_ai_response(self, client, message):
        """异步获取 AI 响应"""
        try:
            # 添加用户消息到历史记录
            self.message_history.append({
                "role": "user",
                "content": message
            })
            
            print(f"Sending message to AI: {message}")
            print(f"Message history: {self.message_history}")
            
            # 使用 asyncio.to_thread 在线程中运行同步 API 调用
            response = await asyncio.to_thread(
                lambda: client.chat.completions.create(
                    model="deepseek-chat",
                    messages=self.message_history
                )
            )
            
            print(f"Raw AI response: {response}")  # 添加原始响应日志
            
            # 获取 AI 的回复内容
            ai_message = response.choices[0].message
            
            print(f"AI message content: {ai_message.content}")  # 添加消息内容日志
            
            # 添加 AI 回复到历史记录
            self.message_history.append({
                "role": "assistant",
                "content": ai_message.content
            })
            
            return ai_message.content
            
        except Exception as e:
            print(f"Detailed error in get_ai_response: {str(e)}")
            print(f"Error type: {type(e)}")
            import traceback
            print(f"Traceback: {traceback.format_exc()}")
            return "抱歉，我现在无法回答这个问题。"

    async def chat_message(self, event):
        """发送消息到 WebSocket"""
        await self.send(text_data=json.dumps({
            'type': event['message_type'],
            'message': event['message'],
            'username': event['username'],
            'profile_pic': event['profile_pic'],
            'message_id': event['message_id']
        }))

    async def save_message(self, username, room, message_type='text', message_content=None, file=None, file_name=None, profile_pic=None):
        """保存消息到数据库"""
        def _create():
            try:
                user = User.objects.filter(username=username).first()
                message = Message.objects.create(
                    username=username,
                    user=user,
                    room=room,
                    message_type=message_type,
                    message_content=message_content,
                    file=file,
                    file_name=file_name,
                    profile_pic=profile_pic or ''
                )
                return message
            except Exception as e:
                print(f"Error saving message: {e}")
                return None
        message = await database_sync_to_async(_create)()
        if message:
            print(f"Message saved: {message.id} in room {room}")
        return message
