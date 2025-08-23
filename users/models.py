from django.db import models
from django.contrib.auth.models import User
from PIL import Image
import os
from django.conf import settings


class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE)
    image = models.ImageField(default='default.jpg', upload_to='profile_pics')

    def __str__(self):
        return f'{self.user.username} Profile'

    def save(self, *args, **kwargs):
        # 先保存模型
        super().save(*args, **kwargs)

        try:
            # 处理图片
            if self.image:
                img_path = os.path.join(settings.MEDIA_ROOT, self.image.name)
                if os.path.exists(img_path):
                    img = Image.open(img_path)
                    # 调整图片大小
                    if img.height > 300 or img.width > 300:
                        output_size = (300, 300)
                        img.thumbnail(output_size)
                        img.save(img_path)
                else:
                    # 如果图片不存在，使用默认图片
                    self.image = 'default.jpg'
                    super().save(update_fields=['image'])
        except Exception as e:
            print(f"Error processing profile image: {e}")
