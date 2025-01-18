FROM python:3.10

# 设置环境变量，防止Python写入pyc文件
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# 设置工作目录
WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    gcc \
    && apt-get clean

# 复制并安装Python依赖
COPY requirements.txt /app/
RUN pip install --upgrade pip
RUN pip install -r requirements.txt

# 复制项目代码
COPY . /app/

# 添加运行应用程序的命令
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]