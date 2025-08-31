#!/bin/bash

# Crypto Trading Bot Deployment Script

set -e

echo "🚀 Starting Crypto Trading Bot Deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Please install Docker first."
        exit 1
    fi
    
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        print_error "Docker Compose is not installed. Please install Docker Compose first."
        exit 1
    fi
    
    print_success "Prerequisites check passed"
}

# Check if .env file exists
check_env_file() {
    print_status "Checking environment configuration..."
    
    if [ ! -f .env ]; then
        print_warning ".env file not found. Creating from template..."
        cp .env.example .env
        print_warning "Please edit .env file with your API keys and configuration"
        print_warning "Required: BINANCE_KEY, BINANCE_SECRET, TELEGRAM_TOKEN, TELEGRAM_WHITELIST_IDS"
        echo
        read -p "Press Enter after configuring .env file..."
    fi
    
    # Validate required environment variables
    source .env
    
    if [ -z "$BINANCE_KEY" ] || [ -z "$BINANCE_SECRET" ]; then
        print_error "Binance API credentials not configured in .env"
        exit 1
    fi
    
    if [ -z "$TELEGRAM_TOKEN" ] || [ -z "$TELEGRAM_WHITELIST_IDS" ]; then
        print_error "Telegram configuration not found in .env"
        exit 1
    fi
    
    print_success "Environment configuration validated"
}

# Create required directories
create_directories() {
    print_status "Creating required directories..."
    
    mkdir -p logs
    mkdir -p data/postgres
    mkdir -p data/redis
    mkdir -p data/rabbitmq
    mkdir -p monitoring/grafana/dashboards
    mkdir -p monitoring/grafana/datasources
    mkdir -p nginx
    
    print_success "Directories created"
}

# Build Docker images
build_images() {
    print_status "Building Docker images..."
    
    docker-compose build --parallel
    
    print_success "Docker images built successfully"
}

# Start services
start_services() {
    print_status "Starting services..."
    
    # Start infrastructure services first
    print_status "Starting infrastructure services..."
    docker-compose up -d postgres redis rabbitmq
    
    # Wait for infrastructure to be ready
    print_status "Waiting for infrastructure services to be ready..."
    sleep 30
    
    # Start application services
    print_status "Starting application services..."
    docker-compose up -d
    
    print_success "All services started"
}

# Wait for services to be healthy
wait_for_services() {
    print_status "Waiting for services to be healthy..."
    
    max_attempts=30
    attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if docker-compose ps | grep -q "unhealthy"; then
            print_status "Attempt $attempt/$max_attempts - Some services still starting..."
            sleep 10
            ((attempt++))
        else
            break
        fi
    done
    
    if [ $attempt -gt $max_attempts ]; then
        print_warning "Some services may not be fully healthy. Check with: docker-compose ps"
    else
        print_success "All services are healthy"
    fi
}

# Display service status
show_status() {
    echo
    print_status "Service Status:"
    docker-compose ps
    echo
    
    print_status "Access Points:"
    echo "📊 Trading Bot API: http://localhost:3000"
    echo "📈 Grafana Dashboard: http://localhost:3000"
    echo "🐰 RabbitMQ Management: http://localhost:15672"
    echo "💾 PgAdmin: http://localhost:5050"
    echo
    
    print_status "Telegram Bot:"
    echo "Send /start to your Telegram bot to begin trading"
    echo
    
    print_status "Useful Commands:"
    echo "📋 View logs: docker-compose logs -f"
    echo "🔄 Restart service: docker-compose restart <service>"
    echo "⏹️  Stop all: docker-compose down"
    echo "🗑️  Clean reset: docker-compose down -v"
    echo
}

# Main deployment function
main() {
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                 Crypto Trading Bot Deployment                ║"
    echo "║                     Production Ready                         ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo
    
    check_prerequisites
    check_env_file
    create_directories
    build_images
    start_services
    wait_for_services
    show_status
    
    print_success "🎉 Crypto Trading Bot deployed successfully!"
    print_status "The bot is now running in ${BOT_MODE:-SIM} mode"
    
    if [ "${BOT_MODE}" = "LIVE" ]; then
        print_warning "⚠️  LIVE TRADING MODE ACTIVE - Real money at risk!"
    else
        print_status "Running in SIM mode with virtual balance"
    fi
}

# Parse command line arguments
case "${1:-deploy}" in
    "deploy"|"start")
        main
        ;;
    "stop")
        print_status "Stopping all services..."
        docker-compose down
        print_success "All services stopped"
        ;;
    "restart")
        print_status "Restarting all services..."
        docker-compose restart
        print_success "All services restarted"
        ;;
    "logs")
        docker-compose logs -f
        ;;
    "status")
        docker-compose ps
        ;;
    "clean")
        print_warning "This will remove all data and containers. Are you sure? (y/N)"
        read -r response
        if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
            docker-compose down -v --remove-orphans
            docker system prune -f
            print_success "System cleaned"
        else
            print_status "Clean operation cancelled"
        fi
        ;;
    "help"|*)
        echo "Usage: $0 [command]"
        echo
        echo "Commands:"
        echo "  deploy, start  - Deploy and start the trading bot (default)"
        echo "  stop          - Stop all services"
        echo "  restart       - Restart all services"
        echo "  logs          - View service logs"
        echo "  status        - Show service status"
        echo "  clean         - Remove all containers and data"
        echo "  help          - Show this help message"
        echo
        ;;
esac