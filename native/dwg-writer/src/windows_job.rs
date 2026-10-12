//! A verified OS process-commit limit, installed before reading or parsing drawing data.
#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};

    type Handle = *mut c_void;
    const PROCESS_MEMORY: u32 = 0x100;
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;
    pub const MEMORY_LIMIT: usize = 1024 * 1024 * 1024;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct BasicLimits {
        process_user_time: i64,
        job_user_time: i64,
        flags: u32,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct IoCounters {
        read_operations: u64,
        write_operations: u64,
        other_operations: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[repr(C)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: i32,
            information: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn IsProcessInJob(process: Handle, job: Handle, result: *mut i32) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetLastError() -> u32;
    }

    pub struct ProcessLimit(Handle);
    impl ProcessLimit {
        pub fn install() -> Result<Self, String> {
            // These structs exactly mirror JOBOBJECT_EXTENDED_LIMIT_INFORMATION from Win32.
            // No KILL_ON_JOB_CLOSE flag: dropping our RAII handle must not kill this process.
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(format!(
                        "Cannot create DWG writer memory job (Windows error {}).",
                        GetLastError()
                    ));
                }
                let job = Self(handle);
                let mut limits: ExtendedLimits = zeroed();
                limits.basic.flags = PROCESS_MEMORY;
                limits.process_memory = MEMORY_LIMIT;
                let length = size_of::<ExtendedLimits>() as u32;
                if SetInformationJobObject(
                    handle,
                    EXTENDED_LIMIT_INFORMATION,
                    &limits as *const _ as *const c_void,
                    length,
                ) == 0
                {
                    return Err(format!(
                        "Cannot set DWG writer memory limit (Windows error {}).",
                        GetLastError()
                    ));
                }
                if AssignProcessToJobObject(handle, GetCurrentProcess()) == 0 {
                    return Err(format!(
                        "Cannot attach DWG writer memory limit (Windows error {}).",
                        GetLastError()
                    ));
                }
                let mut readback: ExtendedLimits = zeroed();
                let mut returned = 0;
                let mut member = 0;
                if QueryInformationJobObject(
                    handle,
                    EXTENDED_LIMIT_INFORMATION,
                    &mut readback as *mut _ as *mut c_void,
                    length,
                    &mut returned,
                ) == 0
                    || returned != length
                    || readback.basic.flags & PROCESS_MEMORY == 0
                    || readback.process_memory != MEMORY_LIMIT
                    || IsProcessInJob(GetCurrentProcess(), handle, &mut member) == 0
                    || member != 1
                {
                    return Err("The DWG writer OS memory limit could not be verified.".into());
                }
                Ok(job)
            }
        }
    }
    impl Drop for ProcessLimit {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
pub use platform::ProcessLimit;

#[cfg(not(windows))]
pub struct ProcessLimit;
#[cfg(not(windows))]
impl ProcessLimit {
    pub fn install() -> Result<Self, String> {
        Err("Portable DWG export is available on Windows only.".into())
    }
}
