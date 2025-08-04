// Session timeout management
class SessionTimeoutManager {
    constructor() {
        this.timeoutDuration = 30 * 60 * 1000; // 30 minutes
        this.warningTime = 5 * 60 * 1000; // 5 minutes before timeout
        this.lastActivity = Date.now();
        this.warningShown = false;
        this.warningElement = null;
        
        this.init();
    }
    
    init() {
        // Create warning element
        this.createWarningElement();
        
        // Set up activity listeners
        this.setupActivityListeners();
        
        // Start monitoring
        this.startMonitoring();
    }
    
    createWarningElement() {
        this.warningElement = document.createElement('div');
        this.warningElement.className = 'session-warning';
        this.warningElement.innerHTML = `
            <div>
                <i class="fas fa-clock"></i>
                <strong>Session Expiring Soon</strong><br>
                Your session will expire in <span id="timeout-countdown">5:00</span> minutes due to inactivity.
            </div>
            <div class="warning-actions">
                <button class="btn-sm btn-extend" onclick="sessionManager.extendSession()">
                    <i class="fas fa-refresh"></i> Extend Session
                </button>
                <button class="btn-sm btn-logout" onclick="sessionManager.logout()">
                    <i class="fas fa-sign-out-alt"></i> Logout Now
                </button>
            </div>
        `;
        document.body.appendChild(this.warningElement);
    }
    
    setupActivityListeners() {
        const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
        
        events.forEach(event => {
            document.addEventListener(event, () => {
                this.updateActivity();
            });
        });
    }
    
    updateActivity() {
        this.lastActivity = Date.now();
        this.warningShown = false;
        
        if (this.warningElement) {
            this.warningElement.classList.remove('show');
        }
        
        // Send activity update to server
        this.sendActivityUpdate();
    }
    
    async sendActivityUpdate() {
        try {
            await fetch('/api/activity-update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ timestamp: Date.now() })
            });
        } catch (error) {
            console.log('Activity update failed:', error);
        }
    }
    
    startMonitoring() {
        setInterval(() => {
            this.checkSessionStatus();
        }, 10000); // Check every 10 seconds
    }
    
    checkSessionStatus() {
        const now = Date.now();
        const timeSinceActivity = now - this.lastActivity;
        const timeUntilTimeout = this.timeoutDuration - timeSinceActivity;
        
        // Show warning 5 minutes before timeout
        if (timeUntilTimeout <= this.warningTime && timeUntilTimeout > 0 && !this.warningShown) {
            this.showWarning(timeUntilTimeout);
        }
        
        // Auto logout when timeout reached
        if (timeUntilTimeout <= 0) {
            this.logout();
        }
    }
    
    showWarning(timeRemaining) {
        this.warningShown = true;
        this.warningElement.classList.add('show');
        
        // Update countdown
        const minutes = Math.floor(timeRemaining / 60000);
        const seconds = Math.floor((timeRemaining % 60000) / 1000);
        const countdownElement = document.getElementById('timeout-countdown');
        if (countdownElement) {
            countdownElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
        
        // Update countdown every second
        const countdownInterval = setInterval(() => {
            timeRemaining -= 1000;
            if (timeRemaining <= 0) {
                clearInterval(countdownInterval);
                this.logout();
            } else {
                const minutes = Math.floor(timeRemaining / 60000);
                const seconds = Math.floor((timeRemaining % 60000) / 1000);
                if (countdownElement) {
                    countdownElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                }
            }
        }, 1000);
    }
    
    async extendSession() {
        try {
            const response = await fetch('/api/extend-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            });
            
            if (response.ok) {
                this.updateActivity();
                this.warningElement.classList.remove('show');
                this.showNotification('Session extended successfully!', 'success');
            } else {
                this.logout();
            }
        } catch (error) {
            console.log('Session extension failed:', error);
            this.logout();
        }
    }
    
    logout() {
        // Hide warning
        if (this.warningElement) {
            this.warningElement.classList.remove('show');
        }
        
        // Redirect to logout
        window.location.href = '/logout?timeout=true';
    }
    
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <i class="fas fa-${type === 'success' ? 'check-circle' : 'info-circle'}"></i>
            <span>${message}</span>
        `;
        
        document.body.appendChild(notification);
        
        // Show notification
        setTimeout(() => {
            notification.classList.add('show');
        }, 100);
        
        // Remove notification after 3 seconds
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => {
                document.body.removeChild(notification);
            }, 300);
        }, 3000);
    }
}

// Initialize session manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.sessionManager = new SessionTimeoutManager();
}); 