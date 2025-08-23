from django.core.management.base import BaseCommand
from chat.models import Room

class Command(BaseCommand):
    help = '为所有没有 slug 的聊天室生成 slug'

    def handle(self, *args, **kwargs):
        rooms = Room.objects.filter(slug='')
        for room in rooms:
            room.save()  # 这会触发 save 方法中的 slug 生成
            self.stdout.write(
                self.style.SUCCESS(f'成功为聊天室 "{room.name}" 生成 slug: {room.slug}')
            ) 