from django import forms
from django.contrib.auth.models import User
from django.contrib.auth.forms import UserCreationForm

from .models import Profile


class UserRegisterForm(UserCreationForm):
    email = forms.EmailField(label='电子邮箱')
    
    class Meta:
        model = User
        fields = ['username', 'email', 'password1', 'password2']
        labels = {
            'username': '用户名',
            'password1': '密码',
            'password2': '确认密码'
        }


class UserUpdateForm(forms.ModelForm):
    email = forms.EmailField(label='电子邮箱')

    class Meta:
        model = User
        fields = ['username', 'email']
        labels = {
            'username': '用户名'
        }


class ProfileUpdateForm(forms.ModelForm):
    class Meta:
        model = Profile
        fields = ['image']
        labels = {
            'image': '头像'
        }
        widgets = {
            'image': forms.FileInput(attrs={'class': 'form-control-file'})
        }
