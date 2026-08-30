from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.disaster import Disaster

router = APIRouter(prefix="/disasters", tags=["Disasters"])


class DisasterCreate(BaseModel):
    type: str
    severity: str
    location: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    description: Optional[str] = ""
    status: Optional[str] = "Active"


class StatusUpdateRequest(BaseModel):
    status: str


@router.get("/")
def get_disasters(
    type: Optional[str] = None,
    hazard_type: Optional[str] = None,
    severity: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None
):
    with SessionLocal() as db:
        q = db.query(Disaster)
        
        hazard = type or hazard_type
        if hazard and hazard.strip():
            q = q.filter(Disaster.type.ilike(f"%{hazard.strip()}%"))
        if severity and severity.strip():
            q = q.filter(Disaster.severity.ilike(f"%{severity.strip()}%"))
        if status and status.strip():
            q = q.filter(Disaster.status.ilike(f"%{status.strip()}%"))
        if search and search.strip():
            term = f"%{search.strip()}%"
            q = q.filter((Disaster.location.ilike(term)) | (Disaster.description.ilike(term)) | (Disaster.type.ilike(term)))

        return q.order_by(Disaster.id.desc()).all()


@router.get("/heatmap")
def get_heatmap_points(hazard_type: Optional[str] = None, severity: Optional[str] = None, active_only: bool = True):
    with SessionLocal() as db:
        q = db.query(Disaster).filter(Disaster.latitude != None, Disaster.longitude != None)
        if active_only:
            q = q.filter(Disaster.status != "Resolved")
        if hazard_type and hazard_type.strip():
            q = q.filter(Disaster.type.ilike(f"%{hazard_type.strip()}%"))
        if severity and severity.strip():
            q = q.filter(Disaster.severity.ilike(f"%{severity.strip()}%"))
        
        disasters = q.all()
        return [
            {
                "id": d.id,
                "type": d.type,
                "severity": d.severity,
                "location": d.location,
                "latitude": d.latitude,
                "longitude": d.longitude,
                "description": d.description,
                "status": d.status
            }
            for d in disasters
        ]


from app.api.events import send_event

@router.post("/")
def create_disaster(data: DisasterCreate):
    with SessionLocal() as db:
        dis = Disaster(**data.dict())
        db.add(dis)
        db.commit()
        db.refresh(dis)
        send_event("disaster_created", {"id": dis.id, "type": dis.type, "location": dis.location})
        return dis


@router.get("/{id}")
def get_disaster(id: int):
    with SessionLocal() as db:
        dis = db.query(Disaster).filter(Disaster.id == id).first()
        if not dis:
            raise HTTPException(status_code=404, detail="Disaster not found")
        return dis


@router.patch("/{id}/status")
def update_disaster_status(id: int, data: StatusUpdateRequest):
    with SessionLocal() as db:
        dis = db.query(Disaster).filter(Disaster.id == id).first()
        if not dis:
            raise HTTPException(status_code=404, detail="Disaster not found")
        dis.status = data.status
        db.commit()
        db.refresh(dis)
        send_event("disaster_status_updated", {"id": dis.id, "status": dis.status})
        return dis


@router.patch("/{id}")
def update_disaster(id: int, data: dict):
    with SessionLocal() as db:
        dis = db.query(Disaster).filter(Disaster.id == id).first()
        if not dis:
            raise HTTPException(status_code=404, detail="Disaster not found")
        for k, v in data.items():
            if hasattr(dis, k):
                setattr(dis, k, v)
        db.commit()
        db.refresh(dis)
        return dis


@router.delete("/{id}")
def delete_disaster(id: int):
    with SessionLocal() as db:
        dis = db.query(Disaster).filter(Disaster.id == id).first()
        if not dis:
            raise HTTPException(status_code=404, detail="Disaster not found")
        db.delete(dis)
        db.commit()
        return {"status": "deleted", "id": id}
