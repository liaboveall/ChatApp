from django.db import models
from django.utils.text import slugify
from django.utils import timezone

# Create your models here.


class Message(models.Model):
    MESSAGE_TYPES = (
        ('text', '文本'),
        ('image', '图片'),
        ('video', '视频'),
        ('file', '文件'),
        ('recall', '撤回提示'),
    )

    username = models.CharField(max_length=50)
    user = models.ForeignKey('auth.User', on_delete=models.CASCADE, null=True)
    room = models.CharField(max_length=50)
    message_content = models.TextField(blank=True, null=True)
    date_added = models.DateTimeField(auto_now_add=True)
    profile_pic = models.ImageField()
    
    # 新增字段
    message_type = models.CharField(max_length=10, choices=MESSAGE_TYPES, default='text')
    file = models.FileField(upload_to='chat_files/%Y/%m/%d/', blank=True, null=True)
    file_name = models.CharField(max_length=255, blank=True, null=True)
    is_deleted = models.BooleanField(default=False)
    is_recalled = models.BooleanField(default=False)
    recall_time = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ('date_added',)

    def __str__(self):
        return f"{self.username}: {self.message_content}"


class Room(models.Model):
    ROOM_TYPES = (
        ('public', '公共聊天室'),
        ('private', '私密聊天室'),
    )
    
    name = models.CharField(max_length=50, verbose_name='聊天室名称')
    slug = models.CharField(max_length=50, unique=True)
    room_type = models.CharField(max_length=10, choices=ROOM_TYPES, default='public', verbose_name='聊天室类型')
    password = models.CharField(max_length=4, blank=True, null=True, verbose_name='访问密码')
    icon = models.ImageField(upload_to='room_icons/', default='room_icons/default.png', verbose_name='聊天室图标')
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.name} ({'私密' if self.room_type == 'private' else '公开'})"

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = slugify(self.name)
        super().save(*args, **kwargs)


# 添加新的模型
class PrivateChat(models.Model):
    initiator = models.ForeignKey('auth.User', on_delete=models.CASCADE, related_name='initiated_chats')
    receiver = models.ForeignKey('auth.User', on_delete=models.CASCADE, related_name='received_chats')
    created_at = models.DateTimeField(auto_now_add=True)
    accepted = models.BooleanField(default=False)
    room_name = models.CharField(max_length=100, unique=True)

    def save(self, *args, **kwargs):
        if not self.room_name:
            # 确保用户ID较小的在前面，这样无论谁发起私聊，房间名都是一样的
            user_ids = sorted([self.initiator.id, self.receiver.id])
            self.room_name = f'private_{user_ids[0]}_{user_ids[1]}'
            print(f"Generated room name: {self.room_name}")
            
        # 检查是否已存在相同用户之间的私聊
        existing_chat = PrivateChat.objects.filter(
            room_name=self.room_name,
            accepted=True
        ).first()
        
        if existing_chat and not self.id:  # 如果是新记录
            print(f"Found existing chat: {existing_chat.id}")
            return existing_chat
            
        super().save(*args, **kwargs)
        return self

    def __str__(self):
        return f'{self.initiator.username} -> {self.receiver.username}'

    class Meta:
        unique_together = ['initiator', 'receiver', 'created_at']


# 添加在线用户模型
class OnlineUser(models.Model):
    user = models.OneToOneField('auth.User', on_delete=models.CASCADE)
    last_seen = models.DateTimeField(auto_now=True)
    is_online = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['user'], name='unique_online_user')
        ]

    def save(self, *args, **kwargs):
        # 确保同一用户只有一条记录
        OnlineUser.objects.filter(user=self.user).delete()
        super().save(*args, **kwargs)

    def __str__(self):
        return f'{self.user.username} - {"Online" if self.is_online else "Offline"}'
