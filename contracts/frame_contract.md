# Frame and response contracts

## Frame
{
  "frameId": "uuid-v4",
  "width": int >0,
  "height": int >0,
  "orientation": "portrait|landscape",
  "timestamp": int,
  "src": "camera|upload"
}

## Request
{
  "frameId": string,
  "question": string,
  "selectedRegion": null | { "nx": float 0-1, "ny": float 0-1 }
}

## Response
{
  "frameId": string,
  "status": "ok|uncertain|view_needed|unavailable",
  "regions": [
    {
      "id": string,
      "nx": float,
      "ny": float,
      "nw": float,
      "nh": float,
      "label": string,
      "confidence": float
    }
  ],
  "explanation": string,
  "sources": [string],
  "model": { "name": string, "revision": string },
  "sam": { "available": bool, "maskId": string|null }
}
