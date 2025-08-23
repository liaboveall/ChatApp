from django.contrib import messages
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.db import models
from django.core.exceptions import ValidationError
from django.http import JsonResponse

from .forms import RoomForm
from .models import Message, Room, OnlineUser, PrivateChat


@login_required()
def chat_home(request):

    form = RoomForm(request.POST or None)

    # 获取所有聊天室
    all_rooms = Room.objects.all().order_by('room_type', 'name')

    if request.method == 'POST' and form.is_valid():
        room_name = form.cleaned_data['name']
        room = get_object_or_404(Room, name=room_name)
        
        # 如果是私密聊天室，重定向到密码验证页面
        if room.room_type == 'private':
            return redirect('join-private-room', room_slug=room.slug)
            
        # 如果是公共聊天室，直接进入
        db_messages = Message.objects.filter(room=room.slug)[:]
        messages.success(request, f"已加入聊天室: {room_name}")
        return render(request, 'chat/chatroom.html', {
            'room_name': room.slug,
            'title': room_name,
            'db_messages': db_messages
        })

    return render(request, 'chat/index.html', {
        'form': form,
        'rooms': all_rooms
    })


@login_required
def chat_room(request, room_name):
    db_messages = Message.objects.filter(room=room_name)[:]

    messages.success(request, f"已加入聊天室: {room_name}")
    return render(request, 'chat/chatroom.html', {
        'room_name': room_name,
        'title': room_name,
        'db_messages': db_messages,
    })


@login_required
def create_room(request):
    if request.method == 'POST':
        form = RoomForm(request.POST, request.FILES)
        if form.is_valid():
            try:
                room = form.save(commit=False)
                room_name = room.name
                room_type = room.room_type
                
                # 检查是否存在同名聊天室
                existing_room = Room.objects.filter(name=room_name)
                if existing_room.exists():
                    existing_type = existing_room.first().get_room_type_display()
                    if room_type == 'private' and existing_room.filter(room_type='public').exists():
                        messages.error(request, '已存在同名的公共聊天室，请使用其他名称!')
                    elif room_type == 'public' and existing_room.filter(room_type='private').exists():
                        messages.error(request, '已存在同名的私密聊天室，请使用其他名称!')
                    else:
                        messages.error(request, f'已存在同名的{existing_type}')
                    return render(request, 'chat/create_room.html', {'form': form})
                
                room.save()
                messages.success(request, f'聊天室 {room.name} 创建成功!')
                return redirect('chat-room', room.slug)
            except ValidationError as e:
                messages.error(request, e.message_dict['name'][0])
                return render(request, 'chat/create_room.html', {'form': form})
    else:
        form = RoomForm()
    return render(request, 'chat/create_room.html', {'form': form})


@login_required
def join_private_room(request, room_slug):
    room = get_object_or_404(Room, slug=room_slug)
    
    # 打印所有聊天室信息
    all_rooms = Room.objects.all()
    print("\n=== 所有聊天室列表 ===")
    for r in all_rooms:
        print(f"名称: {r.name}, 类型: {r.get_room_type_display()}, Slug: {r.slug}")
    print("=====================\n")
    
    # 检查是否是私密聊天室
    if room.room_type != 'private':
        messages.error(request, '此聊天室不是私密聊天室!')
        return redirect('chat-home')
    
    if request.method == 'POST':
        password = request.POST.get('password')
        
        # 检查是否存在同名的公共聊天室
        public_room = Room.objects.filter(
            name=room.name, 
            room_type='public'
        ).exists()
        
        if public_room:
            print(f"\n警告: 发现同名公共聊天室 - {room.name}")
            messages.error(request, '已存在同名的公共聊天室，请使用其他名称!')
            return redirect('chat-home')
            
        if room.password == password:
            # 获取聊天室的历史消息
            db_messages = Message.objects.filter(room=room.slug)[:]
            messages.success(request, f'成功加入聊天室: {room.name}')
            return render(request, 'chat/chatroom.html', {
                'room_name': room.slug,
                'title': room.name,
                'db_messages': db_messages,
                'room': room
            })
        else:
            messages.error(request, '密码错误!')
    return render(request, 'chat/join_private_room.html', {'room': room})


@login_required
def online_users(request):
    # 获取所有在线用户，但排除重复记录
    online_users = OnlineUser.objects.filter(
        is_online=True
    ).select_related('user').distinct()
    
    # 将在线用户数据转换为简单的列表
    users_data = [
        {
            'username': online_user.user.username,
            'id': online_user.user.id,
            'is_current': online_user.user == request.user,
            'profile_pic': online_user.user.profile.image.url if hasattr(online_user.user, 'profile') else None,
        }
        for online_user in online_users
    ]
    
    # 添加 AI 助手到列表开头
    ai_assistant = {
        'username': 'AI助手',
        'id': 'ai',
        'is_current': False,
        'is_ai': True,
        'profile_pic': '/media/ai_avatar/ai_avatar.png'
    }
    users_data.insert(0, ai_assistant)
    
    return render(request, 'chat/online_users.html', {
        'online_users': users_data,
        'title': '在线用户'
    })


@login_required
def private_chat(request, chat_id):
    chat = get_object_or_404(PrivateChat, id=chat_id)
    
    if request.user not in [chat.initiator, chat.receiver]:
        messages.error(request, '您没有权限访问此聊天!')
        return redirect('chat-home')
    
    # 如果是接收者访问，自动接受私聊
    if request.user == chat.receiver and not chat.accepted:
        chat.accepted = True
        chat.save()
        messages.success(request, '您已接受私聊请求')
    
    # 获取聊天记录，包括多媒体消息
    chat_messages = Message.objects.filter(
        room=chat.room_name
    ).order_by('date_added')
    
    return render(request, 'chat/private_chat.html', {
        'chat': chat,
        'messages': chat_messages,
        'title': f'私聊 - {chat.initiator.username} 和 {chat.receiver.username}'
    })


@login_required
def my_private_chats(request):
    # 获取用户参与的所有私聊（作为发起者或接收者）
    private_chats = PrivateChat.objects.filter(
        models.Q(initiator=request.user) | models.Q(receiver=request.user)
    ).select_related('initiator', 'receiver').order_by('-created_at')
    
    return render(request, 'chat/my_private_chats.html', {
        'private_chats': private_chats,
        'title': '我的私聊'
    })


@login_required
def ai_chat(request):
    room_name = f"ai_chat_{request.user.username}"
    messages = Message.objects.filter(room=room_name).order_by('date_added')
    
    return render(request, 'chat/ai_chat.html', {
        'room_name': room_name,
        'messages': messages,
        'title': 'AI 助手聊天'
    })


@login_required
def check_room_name(request):
    room_name = request.GET.get('name', '')
    room_type = request.GET.get('type', '')  # 获取聊天室类型
    
    # 检查是否存在同名聊天室
    existing_room = Room.objects.filter(name=room_name).first()
    if existing_room:
        return JsonResponse({
            'exists': True,
            'message': f'已存在同名的{existing_room.get_room_type_display()}'
        })
    
    return JsonResponse({
        'exists': False,
        'message': '此聊天室名称可用'
    })
