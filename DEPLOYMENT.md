# Phoenix4GE - Production Deployment Guide

## Overview
This guide covers deploying Phoenix4GE in a fully containerized environment using Docker and Docker Compose.

## Prerequisites

### Server Requirements
- Ubuntu 20.04+ or similar Linux distribution
- Minimum 2GB RAM (4GB+ recommended)
- 20GB+ disk space
- Root or sudo access

### Required Software
- Docker Engine 20.10+
- Docker Compose 2.0+
- Git

## Initial Server Setup

### 1. Install Docker

```bash
# Update package index
sudo apt update

# Install prerequisites
sudo apt install -y apt-transport-https ca-certificates curl software-properties-common

# Add Docker's official GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

# Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Start and enable Docker
sudo systemctl start docker
sudo systemctl enable docker

# Add your user to docker group (optional, allows running docker without sudo)
sudo usermod -aG docker $USER
newgrp docker

# Verify installation
docker --version
docker compose version
```

### 2. Clone Repository

```bash
# Navigate to your deployment directory
cd /opt

# Clone the repository
sudo git clone https://github.com/idbugm99/phoenix4ge.git

# Set ownership
sudo chown -R $USER:$USER phoenix4ge

# Navigate to project
cd phoenix4ge
```

### 3. Configure Environment

```bash
# Copy environment template
cp /opt/.env.example /opt/.env

# Edit environment variables
nano /opt/.env
```

**Required Environment Variables:**
```bash
# ============================================
# PRODUCTION ENVIRONMENT VARIABLES
# ============================================

NODE_ENV=production

# Database Configuration
PHOENIX_DB_ROOT_PASSWORD=YOUR_SECURE_ROOT_PASSWORD
PHOENIX_DB_NAME=musenest
PHOENIX_DB_USER=phoenix_user
PHOENIX_DB_PASSWORD=YOUR_SECURE_DB_PASSWORD

# Session Security
SESSION_SECRET=YOUR_LONG_RANDOM_SESSION_SECRET
JWT_SECRET=YOUR_LONG_RANDOM_JWT_SECRET

# Appwrite Configuration (if using)
PHOENIX_APPWRITE_PROJECT_ID=your_project_id
PHOENIX_APPWRITE_API_KEY=your_api_key
APPWRITE_ENDPOINT=https://your-appwrite-domain.com/v1
```

**Generate Secure Secrets:**
```bash
# Generate random secrets
openssl rand -base64 32  # Use for SESSION_SECRET
openssl rand -base64 32  # Use for JWT_SECRET
```

### 4. Create Required Directories

```bash
# Create directories for persistent data
mkdir -p phoenix4ge/uploads
mkdir -p phoenix4ge/public/uploads
mkdir -p phoenix4ge/logs

# Set proper permissions
chmod -R 755 phoenix4ge/uploads
chmod -R 755 phoenix4ge/logs
```

## Deployment

### 1. Build and Start Services

```bash
# Navigate to project root (where docker-compose.yml is)
cd /opt

# Build images
docker compose build phoenix4ge-app

# Start all services
docker compose up -d

# Verify services are running
docker compose ps
```

Expected output:
```
NAME                   STATUS    PORTS
phoenix4ge-app         Up        0.0.0.0:3001->3000/tcp
phoenix4ge-mysql       Up        0.0.0.0:3306->3306/tcp
phoenix4ge-redis       Up        0.0.0.0:6379->6379/tcp
```

### 2. Run Database Migrations

```bash
# Wait for MySQL to be fully ready (check health)
docker compose exec phoenix4ge-mysql mysqladmin ping -h localhost

# Run migrations from inside the app container
docker compose exec phoenix4ge-app npm run migrate

# Verify database setup
docker compose exec phoenix4ge-app npm run verify-db
```

### 3. Verify Deployment

```bash
# Check application health
curl http://localhost:3001/health

# View application logs
docker compose logs -f phoenix4ge-app

# Check all service logs
docker compose logs
```

## Configuration

### Port Configuration

By default, the application runs on:
- **App**: `localhost:3001` (mapped from container port 3000)
- **MySQL**: `localhost:3306`
- **Redis**: `localhost:6379`

To change the external port, edit `docker-compose.yml`:
```yaml
ports:
  - "YOUR_PORT:3000"  # Change YOUR_PORT to desired port
```

### Reverse Proxy Setup (Nginx)

For production, use Nginx as a reverse proxy:

```nginx
# /etc/nginx/sites-available/phoenix4ge

server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 100M;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

Enable the site:
```bash
sudo ln -s /etc/nginx/sites-available/phoenix4ge /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### SSL/HTTPS with Let's Encrypt

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal is configured automatically
```

## Maintenance

### Updating the Application

```bash
# Navigate to project
cd /opt

# Pull latest changes
git pull origin main

# Rebuild and restart services
docker compose down
docker compose build phoenix4ge-app
docker compose up -d

# Run any new migrations
docker compose exec phoenix4ge-app npm run migrate
```

### Viewing Logs

```bash
# All services
docker compose logs

# Specific service
docker compose logs phoenix4ge-app

# Follow logs in real-time
docker compose logs -f phoenix4ge-app

# Last 100 lines
docker compose logs --tail=100 phoenix4ge-app
```

### Database Backup

```bash
# Create backup
docker compose exec phoenix4ge-mysql mysqldump -u root -p${PHOENIX_DB_ROOT_PASSWORD} musenest > backup_$(date +%Y%m%d_%H%M%S).sql

# Restore backup
docker compose exec -T phoenix4ge-mysql mysql -u root -p${PHOENIX_DB_ROOT_PASSWORD} musenest < backup_20241206_120000.sql
```

### Monitoring

```bash
# Check service status
docker compose ps

# Check resource usage
docker stats

# Check specific container
docker stats phoenix4ge-app
```

## Troubleshooting

### Application Won't Start

```bash
# Check logs
docker compose logs phoenix4ge-app

# Check if MySQL is ready
docker compose exec phoenix4ge-mysql mysqladmin ping -h localhost

# Restart services
docker compose restart phoenix4ge-app
```

### Database Connection Issues

```bash
# Verify database credentials in .env
cat /opt/.env | grep PHOENIX_DB

# Test database connection
docker compose exec phoenix4ge-mysql mysql -u phoenix_user -p

# Check network
docker network inspect phoenix4ge-network
```

### Permission Issues

```bash
# Fix upload directory permissions
chmod -R 755 phoenix4ge/uploads
chown -R 1001:1001 phoenix4ge/uploads  # Node user in container

# Fix log directory permissions
chmod -R 755 phoenix4ge/logs
chown -R 1001:1001 phoenix4ge/logs
```

### Clear All Data and Restart

```bash
# WARNING: This will delete all data!
docker compose down -v
docker compose up -d
docker compose exec phoenix4ge-app npm run migrate
```

## Security Checklist

- [ ] Changed all default passwords in `.env`
- [ ] Set strong `SESSION_SECRET` and `JWT_SECRET`
- [ ] Configured firewall to only allow necessary ports
- [ ] Set up SSL/HTTPS with valid certificate
- [ ] Regular database backups configured
- [ ] Monitoring and alerting configured
- [ ] Log rotation configured
- [ ] Kept Docker and system packages updated

## Production Optimization

### Performance Tuning

```yaml
# In docker-compose.yml, add resource limits:
deploy:
  resources:
    limits:
      cpus: '1.0'
      memory: 1G
    reservations:
      cpus: '0.5'
      memory: 512M
```

### Auto-restart on Failure

The `restart: unless-stopped` policy is already configured, ensuring services restart automatically after crashes or server reboots.

## Support

For issues or questions:
- Check logs: `docker compose logs`
- Review this documentation
- Check GitHub issues: https://github.com/idbugm99/phoenix4ge/issues
