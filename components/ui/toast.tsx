"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
    id: string;
    message: string;
    type: ToastType;
    duration?: number;
}

interface ToastContextType {
    addToast: (message: string, type?: ToastType, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType>({ addToast: () => {} });

export function useToast() {
    return useContext(ToastContext);
}

const TOAST_ICONS: Record<ToastType, string> = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️',
};

const TOAST_COLORS: Record<ToastType, string> = {
    success: 'bg-lime-50 border-lime-300 text-lime-800',
    error: 'bg-red-50 border-red-300 text-red-800',
    info: 'bg-blue-50 border-blue-300 text-blue-800',
    warning: 'bg-amber-50 border-amber-300 text-amber-800',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

    const dismissToast = useCallback((id: string) => {
        const timer = timersRef.current.get(id);
        if (timer) clearTimeout(timer);
        timersRef.current.delete(id);
        setToasts(prev => prev.filter(toast => toast.id !== id));
    }, []);

    const addToast = useCallback((message: string, type: ToastType = 'info', duration?: number) => {
        const visibleDuration = duration ?? (type === 'error' || type === 'warning' ? 8000 : 5000);
        const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        setToasts(prev => [...prev, { id, message, type, duration: visibleDuration }]);

        const timer = setTimeout(() => {
            timersRef.current.delete(id);
            setToasts(prev => prev.filter(toast => toast.id !== id));
        }, visibleDuration);
        timersRef.current.set(id, timer);
    }, []);

    useEffect(() => () => {
        for (const timer of timersRef.current.values()) clearTimeout(timer);
        timersRef.current.clear();
    }, []);

    const contextValue = useMemo(() => ({ addToast }), [addToast]);

    return (
        <ToastContext.Provider value={contextValue}>
            {children}

            {/* Toast Container */}
            <div
                aria-label="Notifications"
                className="pointer-events-none fixed inset-x-3 bottom-4 z-[100] flex flex-col gap-2 sm:inset-x-auto sm:bottom-20 sm:right-6 sm:w-full sm:max-w-sm"
            >
                {toasts.map(toast => (
                    <div
                        key={toast.id}
                        role={toast.type === 'error' || toast.type === 'warning' ? 'alert' : 'status'}
                        aria-atomic="true"
                        className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg animate-in slide-in-from-right-5 fade-in duration-300 ${TOAST_COLORS[toast.type]}`}
                    >
                        <span aria-hidden="true" className="text-lg flex-shrink-0">{TOAST_ICONS[toast.type]}</span>
                        <p className="text-sm font-medium flex-1">{toast.message}</p>
                        <button
                            type="button"
                            aria-label="Dismiss notification"
                            onClick={() => dismissToast(toast.id)}
                            className="min-h-11 min-w-11 rounded-lg text-current opacity-70 hover:bg-black/5 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current transition-opacity flex-shrink-0"
                        >
                            ✕
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}
