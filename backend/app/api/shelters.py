from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.shelter import Shelter

router = APIRouter(prefix="/shelters", tags=["Shelters"])


class ShelterCreate(BaseModel):
    name: str
    location: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    capacity: int = 100
    current_occupancy: int = 0
    status: Optional[str] = "Open"
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    facilities: Optional[str] = None


class OccupancyUpdateRequest(BaseModel):
    current_occupancy: Optional[int] = None
    occupancy: Optional[int] = None


def format_shelter(s: Shelter):
    return {
        "id": s.id,
        "name": s.name,
        "location": s.location,
        "latitude": s.latitude,
        "longitude": s.longitude,
        "capacity": s.capacity or 100,
        "current_occupancy": s.current_occupancy or 0,
        "status": s.status or "Open",
        "contact_person": s.contact_person,
        "contact_phone": s.contact_phone,
        "facilities": s.facilities,
        "created_at": s.created_at.isoformat() if s.created_at else None
    }


@router.get("/")
def get_shelters(open_only: Optional[bool] = False):
    with SessionLocal() as db:
        q = db.query(Shelter)
        if open_only:
            q = q.filter(Shelter.status.ilike("Open%"))
        shelters = q.order_by(Shelter.id.desc()).all()
        return [format_shelter(s) for s in shelters]


from app.api.events import send_event

@router.post("/")
def create_shelter(data: ShelterCreate):
    with SessionLocal() as db:
        s = Shelter(**data.dict())
        db.add(s)
        db.commit()
        db.refresh(s)
        send_event("shelter_created", {"id": s.id, "name": s.name})
        return format_shelter(s)


@router.get("/{id}")
def get_shelter(id: int):
    with SessionLocal() as db:
        s = db.query(Shelter).filter(Shelter.id == id).first()
        if not s:
            raise HTTPException(status_code=404, detail="Shelter not found")
        return format_shelter(s)


@router.patch("/{id}/occupancy")
def update_occupancy(id: int, data: OccupancyUpdateRequest):
    with SessionLocal() as db:
        s = db.query(Shelter).filter(Shelter.id == id).first()
        if not s:
            raise HTTPException(status_code=404, detail="Shelter not found")
        
        new_occ = data.current_occupancy if data.current_occupancy is not None else data.occupancy
        if new_occ is not None:
            s.current_occupancy = new_occ
            if s.capacity and s.current_occupancy >= s.capacity:
                s.status = "Full"
            elif s.status == "Full" and s.current_occupancy < (s.capacity or 100):
                s.status = "Open"
            db.commit()
            db.refresh(s)
            send_event("shelter_occupancy_updated", {"id": s.id, "occupancy": s.current_occupancy, "status": s.status})
        return format_shelter(s)


@router.patch("/{id}")
def update_shelter(id: int, data: dict):
    with SessionLocal() as db:
        s = db.query(Shelter).filter(Shelter.id == id).first()
        if not s:
            raise HTTPException(status_code=404, detail="Shelter not found")
        for k, v in data.items():
            if hasattr(s, k):
                setattr(s, k, v)
        db.commit()
        db.refresh(s)
        return format_shelter(s)


@router.delete("/{id}")
def delete_shelter(id: int):
    with SessionLocal() as db:
        s = db.query(Shelter).filter(Shelter.id == id).first()
        if not s:
            raise HTTPException(status_code=404, detail="Shelter not found")
        db.delete(s)
        db.commit()
        return {"status": "deleted", "id": id}
