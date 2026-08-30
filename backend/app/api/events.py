import asyncio
import json
import logging
from fastapi import APIRouter, Request
from starlette.responses import StreamingResponse
from typing import Set

router = APIRouter(prefix="/events", tags=["Events"])
logger = logging.getLogger("events")

# Active client subscriber queues
SUBSCRIBERS: Set[asyncio.Queue] = set()


async def broadcast_event(event_type: str, data: dict = None):
    """
    Broadcasts real-time event to all connected web clients.
    """
    payload = json.dumps({"event": event_type, "data": data or {}})
    message = f"data: {payload}\n\n"
    
    dead_subscribers = set()
    for queue in list(SUBSCRIBERS):
        try:
            queue.put_nowait(message)
        except Exception:
            dead_subscribers.add(queue)
    
    for dead in dead_subscribers:
        SUBSCRIBERS.discard(dead)


def send_event(event_type: str, data: dict = None):
    """
    Synchronous helper to broadcast SSE events without needing async context.
    """
    try:
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(broadcast_event(event_type, data))
        except RuntimeError:
            pass
    except Exception as e:
        logger.warning(f"Failed to broadcast event {event_type}: {e}")


async def event_generator(request: Request):
    client_queue = asyncio.Queue(maxsize=100)
    SUBSCRIBERS.add(client_queue)
    
    # Send initial connection confirmation
    yield f"data: {json.dumps({'event': 'connected', 'status': 'ok'})}\n\n"
    
    try:
        while True:
            # If client disconnected, exit cleanly
            if await request.is_disconnected():
                break
            
            try:
                # Wait for next event or send silent heartbeat every 15s
                msg = await asyncio.wait_for(client_queue.get(), timeout=15.0)
                yield msg
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'event': 'heartbeat', 'time': 'now'})}\n\n"

    except (asyncio.CancelledError, GeneratorExit):
        pass
    finally:
        SUBSCRIBERS.discard(client_queue)


@router.get("/stream")
async def sse_stream(request: Request):
    return StreamingResponse(
        event_generator(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )
