'use server'

import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export async function signIn(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  const supabase = await createServerSupabaseClient()

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return { error: error.message }
  }

  redirect('/dashboard')
}

export async function signUp(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const fullName = formData.get('fullName') as string

  const supabase = await createServerSupabaseClient()

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
      },
    },
  })

  if (error) {
    return { error: error.message }
  }

  // Create the user record in public.users table for app-level access
  if (data.user) {
    const { createServiceRoleClient } = await import('@/lib/supabase-server')
    try {
      const serviceClient = await createServiceRoleClient()
      await serviceClient.from('users').upsert({
        id: data.user.id,
        email: data.user.email,
        full_name: fullName,
        role: 'viewer',
        is_active: true,
      }, { onConflict: 'id' })
    } catch (err) {
      // Non-critical: user can still log in without public.users row
      // The database trigger on auth.users should also create this record
      console.error('Failed to create public.users record:', err)
      console.warn(
        `User ${data.user.id} created in auth.users but public.users insert failed. ` +
        'The database trigger should handle this, but verify the record exists.'
      )
    }
  }

  redirect('/login?message=Account created! You can now sign in.')
}

export async function signOut() {
  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()
  redirect('/login')
}
