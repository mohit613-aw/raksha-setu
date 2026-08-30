from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.database.connection import SessionLocal
from app.models.authority_application import AuthorityApplication
from app.models.user import User

router = APIRouter(prefix="/admin", tags=["Admin"])


class ReviewRequest(BaseModel):
    decision: str
    review_notes: Optional[str] = None


@router.get("/authority-applications")
@router.get("/authority-applications/")
def list_applications(status: Optional[str] = None):
    with SessionLocal() as db:
        q = db.query(AuthorityApplication)
        if status and status.strip():
            q = q.filter(AuthorityApplication.status == status.strip().upper())
        apps = q.order_by(AuthorityApplication.id.desc()).all()
        
        result = []
        for a in apps:
            applicant_user = db.query(User).filter(User.id == a.user_id).first()
            applicant_dict = None
            if applicant_user:
                applicant_dict = {
                    "id": applicant_user.id,
                    "name": applicant_user.name,
                    "email": applicant_user.email,
                    "phone_number": applicant_user.phone_number,
                }
            result.append({
                "id": a.id,
                "user_id": a.user_id,
                "organization_name": a.organization_name or a.organization or "Emergency Agency",
                "designation": a.designation,
                "official_id_badge_number": a.official_id_badge_number or "N/A",
                "official_email": a.official_email,
                "purpose_justification": a.purpose_justification or a.reason or "Field Operations",
                "status": a.status,
                "review_notes": a.review_notes,
                "reviewed_at": a.reviewed_at.isoformat() if a.reviewed_at else None,
                "created_at": a.created_at.isoformat() if a.created_at else None,
                "applicant": applicant_dict
            })
        return result


@router.post("/authority-applications/{app_id}/review")
def review_application(app_id: int, data: ReviewRequest):
    decision = data.decision.strip().upper()
    with SessionLocal() as db:
        app = db.query(AuthorityApplication).filter(AuthorityApplication.id == app_id).first()
        if not app:
            raise HTTPException(status_code=404, detail="Application not found")
        
        app.status = "APPROVED" if decision in ["APPROVE", "APPROVED"] else "REJECTED"
        app.review_notes = data.review_notes
        app.reviewed_at = datetime.utcnow()

        user = db.query(User).filter(User.id == app.user_id).first()
        if user:
            if app.status == "APPROVED":
                user.role = "AUTHORITY_VERIFIED"
            elif app.status == "REJECTED" and user.role == "AUTHORITY_PENDING":
                user.role = "USER"

        db.commit()
        return {"status": app.status, "id": app_id, "message": f"Application #{app_id} marked as {app.status}"}


@router.post("/authority-applications/{app_id}/approve")
def approve_application(app_id: int):
    return review_application(app_id, ReviewRequest(decision="APPROVE"))


@router.post("/authority-applications/{app_id}/reject")
def reject_application(app_id: int):
    return review_application(app_id, ReviewRequest(decision="REJECT"))
