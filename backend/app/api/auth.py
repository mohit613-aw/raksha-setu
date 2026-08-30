import json
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from typing import Optional
from app.database.connection import SessionLocal
from app.models.user import User
from app.models.authority_application import AuthorityApplication
from app.config import GOOGLE_CLIENT_ID, ADMIN_EMAILS

router = APIRouter(prefix="/auth", tags=["Auth"])


class LoginRequest(BaseModel):
    email: str
    name: Optional[str] = None
    role: Optional[str] = None
    phone_number: Optional[str] = None


class AuthorityApplicationRequest(BaseModel):
    organization_name: Optional[str] = None
    organization: Optional[str] = None
    designation: str
    official_id_badge_number: Optional[str] = None
    official_email: Optional[str] = None
    purpose_justification: Optional[str] = None
    reason: Optional[str] = None


def get_current_user_from_header(authorization: Optional[str] = Header(None)):
    email = "citizen@disasterhub.in"
    role = "USER"
    name = "Citizen User"
    if authorization and "Bearer " in authorization:
        token = authorization.split("Bearer ")[1].strip()
        parts = token.split("_")
        if len(parts) >= 4 and parts[0] == "dev" and parts[1] == "token":
            role = parts[2]
            email = "_".join(parts[3:])
            name = email.split("@")[0].title()

    with SessionLocal() as db:
        user = db.query(User).filter(User.email == email).first()
        if not user:
            user = User(
                email=email,
                name=name,
                role=role,
                phone_number="+919876543210",
                avatar_url="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150"
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        return user


@router.post("/login")
@router.post("/dev/login")
def login(data: LoginRequest):
    email = data.email.strip().lower()
    name = data.name or email.split("@")[0].title()
    
    # Auto promote configured admin emails
    if email in ADMIN_EMAILS:
        role = "ADMIN"
    else:
        role = data.role or "USER"

    with SessionLocal() as db:
        user = db.query(User).filter(User.email == email).first()
        if not user:
            user = User(
                email=email,
                name=name,
                role=role,
                phone_number=data.phone_number or "+919876543210",
                avatar_url="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150"
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        else:
            if role != "USER" or user.role == "USER":
                user.role = role
                if data.name:
                    user.name = data.name
                if data.phone_number:
                    user.phone_number = data.phone_number
                db.commit()
                db.refresh(user)

        # Check pending/approved authority application
        app = db.query(AuthorityApplication).filter(AuthorityApplication.user_id == user.id).order_by(AuthorityApplication.id.desc()).first()
        app_dict = None
        if app:
            app_dict = {
                "id": app.id,
                "organization_name": app.organization_name or app.organization,
                "designation": app.designation,
                "official_id_badge_number": app.official_id_badge_number,
                "status": app.status
            }

        return {
            "access_token": f"dev_token_{user.role}_{user.email}",
            "token_type": "bearer",
            "user": {
                "id": user.id,
                "email": user.email,
                "name": user.name,
                "role": user.role,
                "phone_number": user.phone_number,
                "avatar_url": user.avatar_url or "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150",
                "authority_application": app_dict
            }
        }


@router.get("/me")
def get_me(authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    with SessionLocal() as db:
        app = db.query(AuthorityApplication).filter(AuthorityApplication.user_id == user.id).order_by(AuthorityApplication.id.desc()).first()
        app_dict = None
        if app:
            app_dict = {
                "id": app.id,
                "organization_name": app.organization_name or app.organization,
                "designation": app.designation,
                "official_id_badge_number": app.official_id_badge_number,
                "status": app.status
            }

    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "phone_number": user.phone_number,
        "avatar_url": user.avatar_url or "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150",
        "authority_application": app_dict
    }


@router.get("/google/login")
def google_login():
    if not GOOGLE_CLIENT_ID:
        return {"client_id_configured": False, "message": "Google Client ID not configured. Use Quick Dev Login."}
    return {"client_id_configured": True, "auth_url": f"https://accounts.google.com/o/oauth2/v2/auth?client_id={GOOGLE_CLIENT_ID}&response_type=code&scope=openid%20email%20profile"}


@router.get("/google/callback")
def google_callback():
    return {"status": "ok"}


@router.post("/authority-application")
def submit_authority_application(data: AuthorityApplicationRequest, authorization: Optional[str] = Header(None)):
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
        # Update user role to AUTHORITY_PENDING
        user_db = db.query(User).filter(User.id == user.id).first()
        if user_db and user_db.role != "ADMIN" and user_db.role != "AUTHORITY_VERIFIED":
            user_db.role = "AUTHORITY_PENDING"
        db.commit()
        db.refresh(app)
        return {
            "status": "success",
            "message": "Authority application submitted successfully",
            "application_id": app.id
        }


@router.get("/my-application")
def my_application(authorization: Optional[str] = Header(None)):
    user = get_current_user_from_header(authorization)
    with SessionLocal() as db:
        app = db.query(AuthorityApplication).filter(AuthorityApplication.user_id == user.id).order_by(AuthorityApplication.id.desc()).first()
        return app
