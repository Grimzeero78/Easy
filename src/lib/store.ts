'use client'

import { create } from 'zustand'

export type View = 'dashboard' | 'new' | 'workspace' | 'export'

interface AppState {
  view: View
  jobId: string | null
  setView: (view: View, jobId?: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  view: 'dashboard',
  jobId: null,
  setView: (view, jobId = undefined) =>
    set((state) => ({ view, jobId: jobId !== undefined ? jobId : state.jobId })),
}))
