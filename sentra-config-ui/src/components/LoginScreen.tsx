import React, { useState, useEffect } from 'react';
import { IoArrowForward, IoPower, IoRefresh, IoMoon } from 'react-icons/io5';
import { useDevice } from '../hooks/useDevice';
import styles from './LoginScreen.module.css';

interface LoginScreenProps {
    onLogin: (token: string) => Promise<boolean>;
    wallpaper?: string;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, wallpaper }) => {
    const [token, setToken] = useState('');
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(false);
    const [shake, setShake] = useState(false);
    const [time, setTime] = useState(new Date());
    const { isMobile } = useDevice();

    useEffect(() => {
        const timer = setInterval(() => setTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    const handleSubmit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!token.trim()) return;

        setLoading(true);
        setError(false);

        try {
            const success = await onLogin(token);
            if (!success) {
                handleError();
            }
        } catch (err) {
            handleError();
        } finally {
            setLoading(false);
        }
    };

    const handleError = () => {
        setError(true);
        setShake(true);
        setTimeout(() => setShake(false), 500);
        setToken('');
    };

    const formatTime = (date: Date) => {
        return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
    };

    const formatDate = (date: Date) => {
        return date.toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' });
    };

    return (
        <div
            className={styles.container}
            style={{
                backgroundImage: wallpaper ? `url(${wallpaper})` : 'none',
            }}
        >
            {/* Optimized Overlay */}
            <div className={styles.overlay} />

            {/* Top Section: Clock */}
            <div className={styles.clockSection}>
                <div className={styles.time}>
                    {formatTime(time)}
                </div>
                <div className={styles.date}>
                    {formatDate(time)}
                </div>
            </div>

            {/* Center Section: Login Form */}
            <div className={styles.loginSection}>
                {/* Avatar */}
                <div className={styles.avatarContainer}>
                    <img
                        src="/sentra.png"
                        alt="User"
                        className={styles.avatarImg}
                    />
                    {loading && <div className={styles.loadingSpinner} />}
                </div>

                <div className={styles.username}>
                    管理员
                </div>

                {/* Input Area */}
                <form
                    onSubmit={handleSubmit}
                    className={styles.form}
                    style={shake ? { animation: 'shake 0.4s cubic-bezier(.36,.07,.19,.97) both' } : {}}
                >
                    <div className={styles.inputWrapper}>
                        <input
                            type="password"
                            value={token}
                            onChange={(e) => {
                                setToken(e.target.value);
                                setError(false);
                            }}
                            placeholder="输入密码"
                            autoFocus
                            className={styles.input}
                        />
                        <button
                            type="submit"
                            disabled={!token || loading}
                            className={`${styles.submitBtn} ${token ? styles.visible : ''}`}
                        >
                            <IoArrowForward size={18} color="#333" />
                        </button>
                    </div>
                </form>

                {error && (
                    <div className={styles.errorMessage}>
                        密码错误
                    </div>
                )}
            </div>

            {/* Bottom Status Bar */}
            {!isMobile && (
                <div className={styles.footer}>
                    <div className={styles.footerAction}>
                        <div className={styles.actionIcon}>
                            <IoMoon size={20} />
                        </div>
                        <span>睡眠</span>
                    </div>
                    <div className={styles.footerAction}>
                        <div className={styles.actionIcon}>
                            <IoRefresh size={20} />
                        </div>
                        <span>重启</span>
                    </div>
                    <div className={styles.footerAction}>
                        <div className={styles.actionIcon}>
                            <IoPower size={20} />
                        </div>
                        <span>关机</span>
                    </div>
                </div>
            )}
        </div>
    );
};
