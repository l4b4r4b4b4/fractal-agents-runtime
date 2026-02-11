#!/bin/bash
echo "Setting up development environment..."
cd /app || exit 1

echo "Installing dependencies..."
# poetry install --no-root --all-extras --with dev
poetry config virtualenvs.create false
poetry install --no-interaction --all-extras --with dev
# ls .
# ls src
poetry run fractal_agents
# python -m src.system_0.app

# Check if debugpy should be enabled
# if [ "$ENABLE_DEBUGPY" = "true" ]; then
#     echo "Starting fractal-agents service with debugpy enabled..."
#     poetry run python -m debugpy --listen 0.0.0.0:5678 --wait-for-client -m uvicorn src.system_0.app:app --reload --host 0.0.0.0 --port 7373
# else
#     echo "Starting fractal-agents service with hot-reload..."

# fi
