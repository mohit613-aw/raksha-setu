import os
import uuid
import re
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.incident_report import IncidentReport
from app.models.disaster import Disaster
from app.models.user import User
from app.models.notification import Notification
from app.models.communication import CommunicationLog
from app.config import BASE_DIR
from app.api.auth import get_current_user_from_header

router = APIRouter(prefix="/reports", tags=["Reports"])

# Static upload directory used by StaticFiles mount
STATIC_UPLOADS_DIR = os.path.join(BASE_DIR, "static", "uploads")
os.makedirs(STATIC_UPLOADS_DIR, exist_ok=True)

DEFAULT_INDIAN_COORDS = {
    "mumbai": (19.0760, 72.8777),
    "pune": (18.5204, 73.8567),
    "delhi": (28.6139, 77.2090),
    "new delhi": (28.6139, 77.2090),
    "noida": (28.5355, 77.3910),
    "gurugram": (28.4595, 77.0266),
    "bengaluru": (12.9716, 77.5946),
    "bangalore": (12.9716, 77.5946),
    "chennai": (13.0827, 80.2707),
    "kolkata": (22.5726, 88.3639),
    "hyderabad": (17.3850, 78.4867),
    "ahmedabad": (23.0225, 72.5714),
    "jaipur": (26.9124, 75.7873),
    "lucknow": (26.8467, 80.9462),
    "kanpur": (26.4499, 80.3319),
    "patna": (25.5941, 85.1376),
    "bhubaneswar": (20.2961, 85.8245),
    "cuttack": (20.4625, 85.8830),
    "puri": (19.8135, 85.8312),
    "rourkela": (22.2604, 84.8536),
    "balasore": (21.4934, 86.9135),
    "guwahati": (26.1445, 91.7362),
    "dehradun": (30.3165, 78.0322),
    "shimla": (31.1048, 77.1734),
    "srinagar": (34.0837, 74.7973),
    "thiruvananthapuram": (8.5241, 76.9366),
    "kochi": (9.9312, 76.2673),
    "wayanad": (11.6854, 76.1320),
    "ranchi": (23.3441, 85.3096),
    "raipur": (21.2514, 81.6296),
    "bhopal": (23.2599, 77.4126),
    "chandigarh": (30.7333, 76.7794),
    "odisha": (20.9517, 85.0985),
    "maharashtra": (19.7515, 75.7139),
    "kerala": (10.8505, 76.2711),
    "tamil nadu": (11.1271, 78.6569),
    "karnataka": (15.3173, 75.7139),
    "uttar pradesh": (26.8467, 80.9462),
    "bihar": (25.0961, 85.3131),
    "west bengal": (22.9868, 87.8550),
    "assam": (26.2006, 92.9376),
    "gujarat": (22.2587, 71.1924),
    "rajasthan": (27.0238, 74.2179),
    "uttarakhand": (30.0668, 79.0193),
    "himachal pradesh": (31.1048, 77.1734),
}


def resolve_coordinates(location: str, lat: Optional[float], lng: Optional[float]):
    if lat is not None and lng is not None:
        try:
            f_lat, f_lng = float(lat), float(lng)
            if f_lat != 0.0 or f_lng != 0.0:
                return f_lat, f_lng
        except (ValueError, TypeError):
            pass

    loc_lower = (location or "").lower()
    for name, coords in DEFAULT_INDIAN_COORDS.items():
        if name in loc_lower:
            return coords[0], coords[1]
    return 20.5937, 78.9629


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
    calc_lat, calc_lng = resolve_coordinates(location, latitude, longitude)

    with SessionLocal() as db:
        rep = IncidentReport(
            reporter_name=reporter_name.strip(),
            reporter_phone=reporter_phone.strip(),
            title=f"SOS: {category} in {location[:30]}",
            description=description.strip(),
            location=location.strip(),
            latitude=calc_lat,
            longitude=calc_lng,
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

        # 1. Create corresponding active disaster entry for Live Map & Heatmap
        dis = Disaster(
            type=category or "General SOS",
            severity=severity or "High",
            location=location.strip(),
            latitude=calc_lat,
            longitude=calc_lng,
            description=f"[Reported by {reporter_name} ({reporter_phone})] {description}. Relief needed: {relief_type_required}",
            status="Active"
        )
        db.add(dis)

        # 2. Dispatch urgent notifications to all Authority & Admin officers
        auth_users = db.query(User).filter(User.role.in_(["AUTHORITY_VERIFIED", "ADMIN"])).all()
        target_uids = {u.id for u in auth_users} | {2, 3}  # Standard authority officer & national admin IDs
        for uid in target_uids:
            notif = Notification(
                user_id=uid,
                title=f"🚨 URGENT: New Emergency Report #{rep.id}",
                body=f"[{rep.category}] {rep.reporter_name} reported: '{rep.description[:100]}...' at {rep.location}. Relief needed: {rep.relief_type_required}. Contact: {rep.reporter_phone}",
                is_read=False
            )
            db.add(notif)

        # 3. Log SMS / Emergency Telecom Dispatch
        comm_log = CommunicationLog(
            recipient_phone=rep.reporter_phone,
            channel="SMS",
            message_body=f"Raksha Setu: Emergency report #{rep.id} received and dispatched to Disaster Management Authorities & NDRF response units.",
            status="Delivered"
        )
        db.add(comm_log)
        db.commit()

        # 4. Broadcast real-time SSE event to all connected Authority & Admin command dashboards
        from app.api.events import send_event
        send_event("incident_reported", {
            "id": rep.id,
            "title": rep.title,
            "location": rep.location,
            "type": rep.type,
            "category": rep.category,
            "severity": rep.severity,
            "reporter_name": rep.reporter_name,
            "reporter_phone": rep.reporter_phone,
            "relief_type_required": rep.relief_type_required,
            "description": rep.description,
            "latitude": rep.latitude,
            "longitude": rep.longitude,
            "created_at": rep.created_at.isoformat() if rep.created_at else None
        })

        return {
            "status": "success",
            "message": "Incident report submitted and dispatched to Authority & Admin successfully",
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
