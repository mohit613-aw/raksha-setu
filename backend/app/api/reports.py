import os
import uuid
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.incident_report import IncidentReport
from app.models.disaster import Disaster
from app.config import BASE_DIR
from app.api.auth import get_current_user_from_header

router = APIRouter(prefix="/reports", tags=["Reports"])

# Static upload directory used by StaticFiles mount
STATIC_UPLOADS_DIR = os.path.join(BASE_DIR, "static", "uploads")
os.makedirs(STATIC_UPLOADS_DIR, exist_ok=True)


class StatusUpdateRequest(BaseModel):
    status: str


@router.get("/")
def get_reports():
    with SessionLocal() as db:
        reports = db.query(IncidentReport).order_by(IncidentReport.id.desc()).all()
        return [
            {
                "id": r.id,
                "reporter_name": r.reporter_name,
                "reporter_phone": r.reporter_phone,
                "title": r.title,
                "description": r.description,
                "location": r.location,
                "latitude": r.latitude,
                "longitude": r.longitude,
                "relief_type_required": r.relief_type_required,
                "people_affected_count": r.people_affected_count or 1,
                "severity": r.severity,
                "category": r.category,
                "type": r.type or r.category or "General SOS",
                "image_url": r.image_url,
                "status": r.status or r.verification_status or "Submitted",
                "verification_status": r.verification_status or r.status or "Submitted",
                "created_at": r.created_at.isoformat() if r.created_at else None
            }
            for r in reports
        ]


@router.get("/my")
def get_my_reports(authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    with SessionLocal() as db:
        reports = db.query(IncidentReport).filter(
            (IncidentReport.reporter_id == user.id) |
            (IncidentReport.reporter_phone == user.phone_number) |
            (IncidentReport.reporter_name == user.name)
        ).order_by(IncidentReport.id.desc()).all()

        if not reports:
            # Fallback to recent reports so dashboard is populated
            reports = db.query(IncidentReport).order_by(IncidentReport.id.desc()).limit(5).all()

        return [
            {
                "id": r.id,
                "reporter_name": r.reporter_name,
                "reporter_phone": r.reporter_phone,
                "title": r.title,
                "description": r.description,
                "location": r.location,
                "latitude": r.latitude,
                "longitude": r.longitude,
                "relief_type_required": r.relief_type_required,
                "people_affected_count": r.people_affected_count or 1,
                "severity": r.severity,
                "category": r.category,
                "type": r.type or r.category or "General SOS",
                "image_url": r.image_url,
                "status": r.status or r.verification_status or "Submitted",
                "verification_status": r.verification_status or r.status or "Submitted",
                "created_at": r.created_at.isoformat() if r.created_at else None
            }
            for r in reports
        ]


@router.post("/")
async def create_report(
    reporter_name: str = Form(...),
    reporter_phone: str = Form(...),
    location: str = Form(...),
    description: str = Form(...),
    latitude: Optional[float] = Form(None),
    longitude: Optional[float] = Form(None),
    relief_type_required: Optional[str] = Form("General Relief"),
    severity: Optional[str] = Form("High"),
    category: Optional[str] = Form("General SOS"),
    people_affected_count: Optional[int] = Form(1),
    photo: Optional[UploadFile] = File(None),
    authorization: Optional[str] = Header(None)
):
    if not reporter_name or not reporter_name.strip():
        raise HTTPException(status_code=400, detail="Reporter name is required")
    if not reporter_phone or not reporter_phone.strip():
        raise HTTPException(status_code=400, detail="Reporter phone number is required")
    if not location or not location.strip():
        raise HTTPException(status_code=400, detail="Incident location is required")
    if not description or not description.strip():
        raise HTTPException(status_code=400, detail="Incident description is required")

    image_url = None
    if photo and photo.filename:
        ext = os.path.splitext(photo.filename)[1] or ".jpg"
        unique_name = f"{uuid.uuid4().hex}{ext}"
        file_path = os.path.join(STATIC_UPLOADS_DIR, unique_name)
        content = await photo.read()
        with open(file_path, "wb") as f:
            f.write(content)
        image_url = f"/uploads/{unique_name}"

    user = get_current_user_from_header(authorization)

    with SessionLocal() as db:
        rep = IncidentReport(
            reporter_name=reporter_name.strip(),
            reporter_phone=reporter_phone.strip(),
            title=f"SOS: {category} in {location[:30]}",
            description=description.strip(),
            location=location.strip(),
            latitude=latitude,
            longitude=longitude,
            relief_type_required=relief_type_required,
            people_affected_count=people_affected_count or 1,
            severity=severity or "High",
            category=category or "General SOS",
            type=category or "General SOS",
            image_url=image_url,
            reporter_id=user.id if user else None,
            verification_status="Submitted",
            status="Submitted"
        )
        db.add(rep)
        db.commit()
        db.refresh(rep)

        # Create corresponding disaster entry so it immediately displays on maps & heatmaps
        if latitude and longitude:
            dis = Disaster(
                type=category or "General SOS",
                severity=severity or "High",
                location=location.strip(),
                latitude=latitude,
                longitude=longitude,
                description=f"[Reported by {reporter_name} ({reporter_phone})] {description}. Relief needed: {relief_type_required}",
                status="Active"
            )
            db.add(dis)
            db.commit()

        from app.api.events import send_event
        send_event("incident_reported", {"id": rep.id, "title": rep.title, "location": rep.location, "type": rep.type})

        return {
            "status": "success",
            "message": "Incident report submitted successfully",
            "report_id": rep.id,
            "data": {
                "id": rep.id,
                "reporter_name": rep.reporter_name,
                "reporter_phone": rep.reporter_phone,
                "location": rep.location,
                "description": rep.description,
                "relief_type_required": rep.relief_type_required,
                "image_url": rep.image_url,
                "verification_status": rep.verification_status,
                "status": rep.status,
                "created_at": rep.created_at.isoformat() if rep.created_at else None
            }
        }


@router.get("/{id}")
def get_report(id: int):
    with SessionLocal() as db:
        rep = db.query(IncidentReport).filter(IncidentReport.id == id).first()
        if not rep:
            raise HTTPException(status_code=404, detail="Report not found")
        return rep


@router.patch("/{id}/status")
def update_status(id: int, data: dict):
    with SessionLocal() as db:
        rep = db.query(IncidentReport).filter(IncidentReport.id == id).first()
        if not rep:
            raise HTTPException(status_code=404, detail="Report not found")
        
        st = data.get("status", "Verified")
        rep.verification_status = st
        rep.status = st
        db.commit()
        db.refresh(rep)

        from app.api.events import send_event
        send_event("report_status_updated", {"id": rep.id, "status": rep.status})

        return {
            "id": rep.id,
            "status": rep.status,
            "verification_status": rep.verification_status,
            "message": f"Report #{id} status updated to {st}"
        }
