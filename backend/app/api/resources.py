from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.resource import Resource

router = APIRouter(prefix="/resources", tags=["Resources"])


class ResourceCreate(BaseModel):
    item_name: Optional[str] = None
    name: Optional[str] = None
    category: Optional[str] = "General"
    quantity_available: Optional[int] = 0
    delivery_location: Optional[str] = None


class RequestCreate(BaseModel):
    item_name: Optional[str] = None
    name: Optional[str] = None
    quantity_requested: int
    delivery_location: str
    urgency: Optional[str] = "High"


class RequestStatusUpdate(BaseModel):
    status: str


def format_resource(r: Resource):
    # For supply requests, urgency is stored in category
    is_request = (r.quantity_available == 0 and r.quantity_requested > 0)
    return {
        "id": r.id,
        "name": r.name or r.item_name,
        "item_name": r.item_name or r.name,
        "category": r.category or "General",
        "quantity_available": r.quantity_available or 0,
        "quantity_requested": r.quantity_requested or 0,
        "delivery_location": r.delivery_location,
        "urgency": r.category if is_request else None,
        "status": r.status or "Available",
        "requested_by": r.requested_by,
        "created_at": r.created_at.isoformat() if r.created_at else None
    }


@router.get("/")
def get_resources():
    with SessionLocal() as db:
        res = db.query(Resource).filter(Resource.quantity_available > 0).all()
        return [format_resource(r) for r in res]


from app.api.events import send_event

@router.post("/")
def add_resource(data: ResourceCreate):
    name = data.item_name or data.name or "Emergency Relief Supply"
    with SessionLocal() as db:
        r = Resource(
            item_name=name,
            name=name,
            category=data.category or "General",
            quantity_available=data.quantity_available or 0,
            quantity_requested=0,
            delivery_location=data.delivery_location,
            status="Available"
        )
        db.add(r)
        db.commit()
        db.refresh(r)
        send_event("resource_added", {"id": r.id, "name": r.name})
        return format_resource(r)


@router.get("/requests")
@router.get("/requests/")
def get_requests():
    with SessionLocal() as db:
        reqs = db.query(Resource).filter(Resource.quantity_requested > 0).order_by(Resource.id.desc()).all()
        return [format_resource(r) for r in reqs]


@router.post("/requests")
@router.post("/requests/")
@router.post("/request")
def request_resource(data: RequestCreate):
    name = data.item_name or data.name or "Emergency Supplies"
    with SessionLocal() as db:
        r = Resource(
            item_name=name,
            name=name,
            category=data.urgency or "High",  # store urgency in category for requests
            quantity_available=0,
            quantity_requested=data.quantity_requested,
            delivery_location=data.delivery_location,
            status="Pending"
        )
        db.add(r)
        db.commit()
        db.refresh(r)
        send_event("resource_requested", {"id": r.id, "name": r.name, "quantity": r.quantity_requested})
        return format_resource(r)


@router.patch("/requests/{id}/status")
def update_request_status(id: int, data: RequestStatusUpdate):
    with SessionLocal() as db:
        r = db.query(Resource).filter(Resource.id == id).first()
        if not r:
            raise HTTPException(status_code=404, detail="Resource request not found")
        r.status = data.status
        db.commit()
        db.refresh(r)
        send_event("resource_status_updated", {"id": r.id, "status": r.status})
        return format_resource(r)


@router.patch("/{id}")
def update_resource(id: int, data: dict):
    with SessionLocal() as db:
        r = db.query(Resource).filter(Resource.id == id).first()
        if not r:
            raise HTTPException(status_code=404, detail="Resource not found")
        for k, v in data.items():
            if hasattr(r, k):
                setattr(r, k, v)
        db.commit()
        db.refresh(r)
        return format_resource(r)


@router.delete("/{id}")
def delete_resource(id: int):
    with SessionLocal() as db:
        r = db.query(Resource).filter(Resource.id == id).first()
        if not r:
            raise HTTPException(status_code=404, detail="Resource not found")
        db.delete(r)
        db.commit()
        return {"status": "deleted", "id": id}
