from flask import jsonify, request
from . import auth_view
from flask import jsonify, render_template, url_for, flash, redirect, request, session
from flask_login import login_required, login_user, logout_user, current_user
from werkzeug.security import check_password_hash

from app import db
from app.blueprints.web.utils.helpers import register_user, reset_password, send_reset_email, send_verification_email, verify_token
from app.blueprints.web.utils.validators import RegistrationForm, LoginForm, RequestResetForm, RequestVerifyForm, ResetPasswordForm
from app.blueprints.api.auth.models import User

@auth_view.route("/register", methods=['GET', 'POST']) 
def register():
    if current_user.is_authenticated:
        return redirect(url_for('chat_view.user'))
    errors = []
    form = RegistrationForm()
    if request.method == 'POST' and form.validate_on_submit():
        email = form.email.data
        success, user = register_user(form)
        if success:
            flash(f'Acount created!', 'success')
            # send_verification_email(user, email)
            flash(f'Email verification link send to {email}. Verify your email before login.', 'success')
            errors.append(f'Email verification link send to {email}. Follow the link to Verify your email.')
            return redirect(url_for('auth_view.login'))
        else:
            flash(f'Error creating account: {user}', 'error')
    return render_template('register.html', title='Register', form=form, errors=errors)


@auth_view.route("/login", methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('chat_view.user'))
    errors = []
    form = LoginForm()
    if form.validate_on_submit():
        user = User.query.filter_by(username=form.username.data).first()
        if user and check_password_hash(user.password, form.password.data):
            # if user.verified:
            login_user(user, remember=True)
            session['user_id'] = current_user.user_id
            next_page = request.args.get('next')
            return redirect(next_page) if next_page else redirect(url_for('chat_view.user'))
            # else:
            errors.append('Email not Verified. You need to verify your email before login')
            flash('Login Failed. Email not Verified', 'warning')
        else:
            text = 'Login Failed. Please check username and password'
            flash(text, 'warning')
            errors.append(text)
    return render_template('login.html', title='Login', form=form, errors=errors)

@auth_view.route("/logout")
def logout():
    session.pop('user_id', None)
    logout_user()
    flash('Logout success', 'success')
    return redirect(url_for('auth_view.login'))

@auth_view.route("/reset-password", methods=['GET', 'POST'])
def reset_request():
    if current_user.is_authenticated:
        return redirect(url_for('chat_view.user'))
    errors = []
    form = RequestResetForm()
    if form.validate_on_submit():
        user = User.query.filter_by(email=form.email.data).first()
        send_reset_email(user)
        text = 'Email sent with instructions to resset password'
        errors.append(text)
        flash(text, 'success')
    return render_template('reset-request.html', title='Reset Password', form=form, errors=errors)


@auth_view.route("/reset-password/<token>", methods=['GET', 'POST'])
def reset_token(token):
    if current_user.is_authenticated:
        return redirect(url_for('chat_view.user'))
    user = User.verify_reset_token(token)
    if not user:
        flash('Token is invalid or expired', 'warning')
        return redirect(url_for('auth_view.reset_request'))
    form = ResetPasswordForm()
    if form.validate_on_submit():
        success, err = reset_password(form, user)
        if success:
            flash(f'Your password has been updated. You are now able to log in with your new password', 'success')
            return redirect(url_for('auth_view.login'))
        else:
            flash(f'Error resetting password: {err}', 'error')

    return render_template('reset-token.html', title='Reset Password', form=form)


@auth_view.route("/verify-email", methods=['GET', 'POST'])
def verify_request():
    if current_user.is_authenticated:
        return redirect(url_for('chat_view.user'))
    form = RequestVerifyForm()
    if form.validate_on_submit():
        email = form.email.data
        user = User.query.filter_by(email=email)
        send_verification_email(user.user_id, email)
        flash(f'Email verification link send to {email}. Verify your email before login.', 'success')
        return redirect(url_for('auth_view.login'))
    return render_template('verify-request.html', title='Verify Email', form=form)


@auth_view.route('/verify-email/<token>')
def verify_email(token):
    if current_user.is_authenticated:
        return redirect(url_for('chat_view.user'))
    title = 'Email Verified!'
    text = 'Your email has been verified. Redirecting to login...'
    icon = 'success'
    user = verify_token(token)
    if user:
        user.verified = True
        db.session.commit()
        flash(f'Your email has been verified. You are now able to log in', 'success')
    if not user:
        title = 'Email Verification Failed!'
        text = 'Token is invalid or expired'
        icon = 'warning'
        flash('Token is invalid or expired', 'warning')

    return render_template('verify-email.html', title='Verify Email', _title=title, text=text, icon=icon)

@auth_view.route('/get_user_details', methods=['GET'])
@login_required
def get_user():
    return jsonify(
        {
            "message": "User details", 
            "user_details": {
                "user_id": current_user.user_id,
                "username":current_user.username, 
                "email":current_user.email,
                "profile": current_user.profile
            }
        }
    )