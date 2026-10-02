//! Explorer thumbnails for PDF files: a shell thumbnail provider
//! (IThumbnailProvider + IInitializeWithStream) that draws the first page
//! with the PDF renderer built into Windows (Windows.Data.Pdf). Registered by
//! the installer with regsvr32 for .pdf (SystemFileAssociations, so a PDF
//! program that registers its own thumbnails keeps them).

#![allow(non_snake_case)]

use std::cell::RefCell;
use std::ffi::c_void;
use windows::core::{implement, Interface, Ref, Result, GUID, HRESULT, PCWSTR};
use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat};
use windows::Storage::Streams::{Buffer, DataReader, IRandomAccessStream, InMemoryRandomAccessStream};
use windows::Win32::Foundation::{CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_POINTER, HMODULE, S_FALSE, S_OK};
use windows::Win32::Graphics::Gdi::{CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl, IStream};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::Registry::{RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ};
use windows::Win32::System::WinRT::{CreateRandomAccessStreamOverStream, BSOS_DEFAULT};
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithStream, IInitializeWithStream_Impl};
use windows::Win32::UI::Shell::{IThumbnailProvider, IThumbnailProvider_Impl, WTSAT_ARGB, WTS_ALPHATYPE};

/// {6A3B9E52-8C1F-4D27-9B5E-0A7D3C2F41B8}
pub const CLSID_ADIKA_THUMBS: GUID = GUID::from_u128(0x6a3b9e52_8c1f_4d27_9b5e_0a7d3c2f41b8);
/// The shell's thumbnail handler category.
const THUMBNAIL_HANDLER: &str = "{e357fccd-a995-4576-b01f-234630154e96}";

static mut MODULE: HMODULE = HMODULE(std::ptr::null_mut());

/// Renders page 1 of a PDF so that its longer side is `size` pixels: BGRA, premultiplied, top-down.
pub fn render_first_page(stream: &IRandomAccessStream, size: u32) -> Result<(u32, u32, Vec<u8>)> {
    let doc = PdfDocument::LoadFromStreamAsync(stream)?.get()?;
    if doc.PageCount()? == 0 {
        return Err(E_FAIL.into());
    }
    let page = doc.GetPage(0)?;
    let s = page.Size()?;
    let (w, h) = if s.Width >= s.Height {
        (size, ((size as f32) * s.Height / s.Width).round().max(1.0) as u32)
    } else {
        (((size as f32) * s.Width / s.Height).round().max(1.0) as u32, size)
    };
    let opts = PdfPageRenderOptions::new()?;
    opts.SetDestinationWidth(w)?;
    opts.SetDestinationHeight(h)?;
    let out = InMemoryRandomAccessStream::new()?;
    page.RenderWithOptionsToStreamAsync(&out, &opts)?.get()?;
    out.Seek(0)?;
    let decoder = BitmapDecoder::CreateAsync(&out)?.get()?;
    let bmp = decoder.GetSoftwareBitmapConvertedAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)?.get()?;
    let (bw, bh) = (bmp.PixelWidth()? as u32, bmp.PixelHeight()? as u32);
    let buf = Buffer::Create(bw * bh * 4)?;
    bmp.CopyToBuffer(&buf)?;
    let reader = DataReader::FromBuffer(&buf)?;
    let mut px = vec![0u8; (bw * bh * 4) as usize];
    reader.ReadBytes(&mut px)?;
    Ok((bw, bh, px))
}

/// A 32-bit top-down DIB section with the pixels.
fn to_hbitmap(w: u32, h: u32, px: &[u8]) -> Result<HBITMAP> {
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w as i32, biHeight: -(h as i32), biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() };
    let mut bits: *mut c_void = std::ptr::null_mut();
    let bmp = unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)? };
    if bits.is_null() {
        return Err(E_FAIL.into());
    }
    unsafe { std::ptr::copy_nonoverlapping(px.as_ptr(), bits as *mut u8, px.len()) };
    Ok(bmp)
}

#[implement(IThumbnailProvider, IInitializeWithStream)]
pub struct Provider {
    stream: RefCell<Option<IStream>>,
}

impl Provider {
    pub fn new() -> Self {
        Provider { stream: RefCell::new(None) }
    }
}

impl Default for Provider {
    fn default() -> Self {
        Self::new()
    }
}

impl IInitializeWithStream_Impl for Provider_Impl {
    fn Initialize(&self, pstream: Ref<'_, IStream>, _grfmode: u32) -> Result<()> {
        *self.stream.borrow_mut() = Some(pstream.ok()?.clone());
        Ok(())
    }
}

impl IThumbnailProvider_Impl for Provider_Impl {
    fn GetThumbnail(&self, cx: u32, phbmp: *mut HBITMAP, pdwalpha: *mut WTS_ALPHATYPE) -> Result<()> {
        if phbmp.is_null() || pdwalpha.is_null() {
            return Err(E_POINTER.into());
        }
        let stream = self.stream.borrow().clone().ok_or(windows::core::Error::from(E_FAIL))?;
        let ras: IRandomAccessStream = unsafe { CreateRandomAccessStreamOverStream(&stream, BSOS_DEFAULT)? };
        let (w, h, px) = render_first_page(&ras, cx.clamp(16, 2560))?;
        let bmp = to_hbitmap(w, h, &px)?;
        unsafe {
            *phbmp = bmp;
            *pdwalpha = WTSAT_ARGB;
        }
        Ok(())
    }
}

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, outer: Ref<'_, windows::core::IUnknown>, riid: *const GUID, ppv: *mut *mut c_void) -> Result<()> {
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let unknown: windows::core::IUnknown = Provider::new().into();
        unsafe { unknown.query(riid, ppv).ok() }
    }

    fn LockServer(&self, _lock: windows::core::BOOL) -> Result<()> {
        Ok(())
    }
}

#[no_mangle]
extern "system" fn DllMain(module: HMODULE, reason: u32, _: *mut c_void) -> windows::core::BOOL {
    if reason == 1 {
        unsafe { MODULE = module };
    }
    true.into()
}

#[no_mangle]
extern "system" fn DllGetClassObject(rclsid: *const GUID, riid: *const GUID, ppv: *mut *mut c_void) -> HRESULT {
    unsafe {
        if ppv.is_null() || rclsid.is_null() {
            return E_POINTER;
        }
        *ppv = std::ptr::null_mut();
        if *rclsid != CLSID_ADIKA_THUMBS {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = Factory.into();
        factory.query(riid, ppv)
    }
}

#[no_mangle]
extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_FALSE
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn set(root: HKEY, path: &str, name: Option<&str>, value: &str) -> Result<()> {
    unsafe {
        let mut key = HKEY::default();
        RegCreateKeyExW(root, PCWSTR(wide(path).as_ptr()), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut key, None).ok()?;
        let v = wide(value);
        let bytes = std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 2);
        let n = name.map(wide);
        RegSetValueExW(key, n.as_ref().map(|x| PCWSTR(x.as_ptr())).unwrap_or(PCWSTR::null()), None, REG_SZ, Some(bytes)).ok()
    }
}

fn clsid_string() -> String {
    format!("{{{:?}}}", CLSID_ADIKA_THUMBS).to_ascii_uppercase()
}

fn register(root: HKEY) -> Result<()> {
    let mut path = [0u16; 1024];
    let n = unsafe { GetModuleFileNameW(Some(MODULE), &mut path) } as usize;
    let dll = String::from_utf16_lossy(&path[..n]);
    let clsid = clsid_string();
    set(root, &format!("Software\\Classes\\CLSID\\{clsid}"), None, "Adika PDF Editor thumbnails")?;
    set(root, &format!("Software\\Classes\\CLSID\\{clsid}\\InprocServer32"), None, &dll)?;
    set(root, &format!("Software\\Classes\\CLSID\\{clsid}\\InprocServer32"), Some("ThreadingModel"), "Apartment")?;
    set(root, &format!("Software\\Classes\\SystemFileAssociations\\.pdf\\ShellEx\\{THUMBNAIL_HANDLER}"), None, &clsid)
}

/// regsvr32: for every user when allowed, otherwise for the current user.
#[no_mangle]
extern "system" fn DllRegisterServer() -> HRESULT {
    match register(HKEY_LOCAL_MACHINE).or_else(|_| register(HKEY_CURRENT_USER)) {
        Ok(()) => S_OK,
        Err(e) => e.code(),
    }
}

#[no_mangle]
extern "system" fn DllUnregisterServer() -> HRESULT {
    let clsid = clsid_string();
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        unsafe {
            let _ = RegDeleteTreeW(root, PCWSTR(wide(&format!("Software\\Classes\\CLSID\\{clsid}")).as_ptr()));
            let _ = RegDeleteTreeW(root, PCWSTR(wide(&format!("Software\\Classes\\SystemFileAssociations\\.pdf\\ShellEx\\{THUMBNAIL_HANDLER}")).as_ptr()));
        }
    }
    S_OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED, STGM_READ};
    use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;

    /// A one-page PDF (200 × 100 pt) with a black box, written by hand.
    fn sample() -> Vec<u8> {
        let content = b"0 0 0 rg 20 20 160 60 re f";
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{}\nendstream", content.len(), std::str::from_utf8(content).unwrap()),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offs = vec![];
        for (i, o) in objs.iter().enumerate() {
            offs.push(out.len());
            out.extend(format!("{} 0 obj\n{}\nendobj\n", i + 1, o).as_bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).as_bytes());
        for o in offs {
            out.extend(format!("{:010} 00000 n \n", o).as_bytes());
        }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n", objs.len() + 1, xref).as_bytes());
        out
    }

    #[test]
    fn draws_the_first_page_as_a_thumbnail() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let path = std::env::temp_dir().join("adika-thumb-test.pdf");
        std::fs::write(&path, sample()).unwrap();
        let p = wide(path.to_str().unwrap());
        let stream: IStream = unsafe { SHCreateStreamOnFileEx(PCWSTR(p.as_ptr()), STGM_READ.0, 0, false, None).unwrap() };
        let provider: IThumbnailProvider = Provider::new().into();
        let init: IInitializeWithStream = provider.cast().unwrap();
        unsafe { init.Initialize(&stream, 0).unwrap() };
        let mut bmp = HBITMAP::default();
        let mut alpha = WTS_ALPHATYPE::default();
        unsafe { provider.GetThumbnail(256, &mut bmp, &mut alpha).unwrap() };
        let mut info = BITMAP::default();
        let n = unsafe { GetObjectW(bmp.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut info as *mut _ as *mut c_void)) };
        assert!(n > 0);
        // 200 × 100 pt -> 256 × 128 px.
        assert_eq!((info.bmWidth, info.bmHeight.abs()), (256, 128));
        assert_eq!(alpha, WTSAT_ARGB);
        unsafe {
            let _ = DeleteObject(bmp.into());
        }
    }

    #[test]
    fn class_factory_hands_out_the_provider() {
        let mut ppv: *mut c_void = std::ptr::null_mut();
        let hr = DllGetClassObject(&CLSID_ADIKA_THUMBS, &IClassFactory::IID, &mut ppv);
        assert_eq!(hr, S_OK);
        let factory = unsafe { IClassFactory::from_raw(ppv) };
        let provider: IThumbnailProvider = unsafe { factory.CreateInstance(None).unwrap() };
        assert!(provider.cast::<IInitializeWithStream>().is_ok());
        let other = GUID::from_u128(1);
        assert_eq!(DllGetClassObject(&other, &IClassFactory::IID, &mut ppv), CLASS_E_CLASSNOTAVAILABLE);
    }
}
