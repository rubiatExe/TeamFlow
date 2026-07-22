import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Expose the Python OCR microservice URL to server-side API routes.
  // In production, set OCR_SERVICE_URL to the Cloud Run service URL.
  // In local dev, leave unset — the parser route defaults to http://localhost:8000.
  env: {
    OCR_SERVICE_URL: process.env.OCR_SERVICE_URL || "http://localhost:8000",
  },
};

export default nextConfig;
