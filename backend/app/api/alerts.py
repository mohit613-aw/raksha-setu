from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.alert import Alert
from app.services.imd_service import imd_service

router = APIRouter(prefix="/alerts", tags=["Alerts"])


class AlertCreate(BaseModel):
    title: str
    message: str
    severity: Optional[str] = "Warning"
    target_region: Optional[str] = "National"
    hazard_type: Optional[str] = "General"
    is_active: Optional[bool] = True
    source: Optional[str] = "Command Operations"


def format_alert(a: Alert):
    return {
        "id": a.id,
        "title": a.title,
        "message": a.message,
        "severity": a.severity or "Warning",
        "target_region": a.target_region or "National",
        "hazard_type": a.hazard_type or "General",
        "is_active": True if a.is_active is None else bool(a.is_active),
        "source": a.source or "Command Operations",
        "created_at": a.created_at.isoformat() if a.created_at else None
    }


@router.get("/")
def get_alerts(active_only: bool = False):
    with SessionLocal() as db:
        q = db.query(Alert)
        if active_only:
            q = q.filter(Alert.is_active == True)
        alerts = q.order_by(Alert.id.desc()).all()
        return [format_alert(a) for a in alerts]


from app.api.events import send_event

@router.post("/")
def create_alert(data: AlertCreate):
    with SessionLocal() as db:
        a = Alert(**data.dict())
        db.add(a)
        db.commit()
        db.refresh(a)
        send_event("alert_broadcast", {"id": a.id, "title": a.title, "severity": a.severity, "target_region": a.target_region})
        return format_alert(a)


@router.get("/imd/status")
@router.get("/imd-status")
def imd_status():
    with SessionLocal() as db:
        count = db.query(Alert).filter(Alert.source.ilike("%IMD%"), Alert.is_active == True).count()
        return {
            "status": "OPERATIONAL",
            "last_poll": datetime.utcnow().isoformat(),
            "active_count": count
        }


@router.post("/imd/ingest")
async def trigger_imd_ingestion():
    with SessionLocal() as db:
        success = await imd_service.ingest_once(db=db)
        count = db.query(Alert).filter(Alert.is_active == True).count()
        send_event("imd_ingest_completed", {"active_alerts_count": count})
        return {
            "status": "success",
            "message": "IMD early-warning bulletin ingestion cycle successfully completed.",
            "active_alerts_count": count
        }


@router.post("/{id}/deactivate")
@router.patch("/{id}/deactivate")
def deactivate_alert(id: int):
    with SessionLocal() as db:
        a = db.query(Alert).filter(Alert.id == id).first()
        if not a:
            raise HTTPException(status_code=404, detail="Alert not found")
        a.is_active = False
        db.commit()
        db.refresh(a)
        return {"status": "deactivated", "id": id, "alert": format_alert(a)}


@router.delete("/{id}")
def delete_alert(id: int):
    with SessionLocal() as db:
        a = db.query(Alert).filter(Alert.id == id).first()
        if not a:
            raise HTTPException(status_code=404, detail="Alert not found")
        db.delete(a)
        db.commit()
        return {"status": "deleted", "id": id}
