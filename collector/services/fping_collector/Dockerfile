FROM python:3.12-slim

# fping must be installed at the OS level — pip cannot provide it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fping traceroute \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

CMD ["python", "-u", "main.py"]
