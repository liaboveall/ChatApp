"""
Crispy form for entering a room name
"""
from django import forms
from .models import Room


class RoomForm(forms.ModelForm):
    """
    Normal form, not connected to models.
    """
    password = forms.CharField(
        max_length=4,
        required=False,
        widget=forms.PasswordInput(),
        help_text='私密聊天室需要4位数密码'
    )

    class Meta:
        model = Room
        fields = ['name', 'room_type', 'password', 'icon']
        labels = {
            'name': '聊天室名称',
            'room_type': '聊天室类型',
            'password': '访问密码',
            'icon': '聊天室图标'
        }

    def clean(self):
        cleaned_data = super().clean()
        room_type = cleaned_data.get('room_type')
        password = cleaned_data.get('password')
        
        if room_type == 'private' and not password:
            raise forms.ValidationError('私密聊天室必须设置密码')
        
        if password and len(password) != 4:
            raise forms.ValidationError('密码必须是4位数')
        
        return cleaned_data
