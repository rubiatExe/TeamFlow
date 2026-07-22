FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy service files
COPY . .

# Expose ports
# 8000 → OCR Extraction API (main.py / uvicorn)
# 8001 → MCP Server (mcp_server.py / FastMCP)
EXPOSE 8000
EXPOSE 8001

# Default: start the OCR API
# To run the MCP server instead, override CMD: python mcp_server.py
CMD sh -c "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"
