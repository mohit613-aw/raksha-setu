from fastapi import APIRouter, Header
from pydantic import BaseModel
from typing import Optional
from app.database.connection import SessionLocal
from app.models.disaster import Disaster
from app.models.incident_report import IncidentReport
from app.models.duplicate_match import DuplicateMatch
from app.models.missing_person import MissingPerson
from app.models.found_suggestion import FoundSuggestion
from app.models.shelter import Shelter
from app.models.resource import Resource
from app.models.authority_application import AuthorityApplication
from app.api.auth import get_current_user_from_header

router = APIRouter(prefix="/authority", tags=["Authority"])


class AuthorityApplyRequest(BaseModel):
    organization: Optional[str] = None
    organization_name: Optional[str] = None
    designation: str
    official_id_badge_number: Optional[str] = None
    official_email: Optional[str] = None
    reason: Optional[str] = None
    purpose_justification: Optional[str] = None


@router.post("/apply")
def apply(data: AuthorityApplyRequest, authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    org_name = data.organization_name or data.organization or "Emergency Responder Unit"
    justification = data.purpose_justification or data.reason or "Operational disaster relief"

    with SessionLocal() as db:
        app = AuthorityApplication(
            user_id=user.id,
            organization_name=org_name,
            organization=org_name,
            designation=data.designation,
            official_id_badge_number=data.official_id_badge_number or "BADGE-TEMP",
            official_email=data.official_email,
            purpose_justification=justification,
            reason=justification,
            status="PENDING"
        )
        db.add(app)
        db.commit()
        db.refresh(app)
        return {"status": "submitted", "id": app.id, "data": data.dict()}


@router.get("/my-application")
def my_application(authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    with SessionLocal() as db:
        return db.query(AuthorityApplication).filter(AuthorityApplication.user_id == user.id).order_by(AuthorityApplication.id.desc()).first()


@router.get("/dashboard-metrics")
def get_dashboard_metrics():
    with SessionLocal() as db:
        # Disasters
        active_disasters = db.query(Disaster).filter(Disaster.status != "Resolved").count()
        critical_disasters = db.query(Disaster).filter(
            Disaster.status != "Resolved",
            Disaster.severity.in_(["Critical", "High", "CRITICAL", "HIGH"])
        ).count()

        # Pending reports / verifications
        pending_reports = db.query(IncidentReport).filter(
            IncidentReport.verification_status.in_(["Pending", "Pending Verification", "Submitted", "Under Verification"])
        ).count()
        pending_matches = db.query(DuplicateMatch).filter(DuplicateMatch.status == "PENDING").count()
        total_pending_verifications = max(pending_reports, pending_matches)

        # Missing persons & sightings
        active_missing = db.query(MissingPerson).filter(MissingPerson.status == "MISSING").count()
        pending_sightings = db.query(FoundSuggestion).filter(FoundSuggestion.status == "PENDING").count()

        # Shelters
        shelters = db.query(Shelter).all()
        total_capacity = sum(s.capacity or 0 for s in shelters) or 1
        total_occupancy = sum(s.current_occupancy or 0 for s in shelters)
        util_pct = min(100, int((total_occupancy / total_capacity) * 100)) if total_capacity > 0 else 0

        # Resources
        pending_resources = db.query(Resource).filter(
            Resource.quantity_requested > 0,
            Resource.status.in_(["Pending", "PENDING", "Requested"])
        ).count()

        return {
            "active_disasters_count": active_disasters,
            "critical_disasters_count": critical_disasters,
            "pending_verification_count": total_pending_verifications,
            "active_missing_count": active_missing,
            "found_suggestions_pending_count": pending_sightings,
            "shelter_utilization_percent": util_pct,
            "shelter_occupancy_total": total_occupancy,
            "shelter_capacity_total": total_capacity,
            "pending_resource_requests_count": pending_resources
        }
