use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Context};
use djengine_analysis::{decode_file, extract_beats_with_bpm_hint, extract_peaks, read_bpm_tag};
use djengine_audio::backend::{Backend, CpalBackend};
use djengine_audio::{Command, DecodedTrack, Engine, EngineConfig, EngineEvent, Tick};
use djengine_core::BeatGrid;
use rtrb::RingBuffer;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{self, Duration as TokioDuration};

use crate::protocol::*;
use crate::tick_ring::TickRing;

pub async fn run_stdio_server() -> anyhow::Result<()> {
    let (sample_rate, channels) = CpalBackend::default_output_info().unwrap_or((48_000, 2));
    let config = EngineConfig {
        device_sample_rate: sample_rate,
        output_channels: channels,
        ..EngineConfig::default()
    };

    let (command_tx, command_rx) = RingBuffer::<Command>::new(1024);
    let (telemetry_tx, telemetry_rx) = RingBuffer::<Tick>::new(4096);
    let (event_tx, event_rx) = RingBuffer::<EngineEvent>::new(4096);
    let mut engine = Engine::with_rings(config, command_rx, telemetry_tx, event_tx);
    let stream = CpalBackend
        .start(move |output, _info| engine.process(output))
        .context("failed to start CPAL output")?;

    let tick_thread = spawn_tick_writer(telemetry_rx);
    let result = serve_lines(command_tx, event_rx).await;
    drop(stream);
    if let Some((running, handle)) = tick_thread {
        running.store(false, Ordering::Release);
        let _ = handle.join();
    }
    result
}

#[derive(Debug, Default)]
struct ServerState {
    subscriptions: EventSubscriptions,
    next_subscription_id: u64,
}

#[derive(Debug, Default)]
struct EventSubscriptions {
    deck: bool,
    transport: bool,
    scheduler: bool,
    loop_events: bool,
    sync: bool,
    master: bool,
}

impl EventSubscriptions {
    fn subscribe(&mut self, event: &str) {
        match event {
            "all" => {
                self.deck = true;
                self.transport = true;
                self.scheduler = true;
                self.loop_events = true;
                self.sync = true;
                self.master = true;
            }
            "deck" => self.deck = true,
            "transport" => self.transport = true,
            "scheduler" => self.scheduler = true,
            "loop" | "loops" => self.loop_events = true,
            "sync" => self.sync = true,
            "master" => self.master = true,
            _ => {}
        }
    }

    fn unsubscribe(&mut self, event: &str) {
        match event {
            "all" => *self = Self::default(),
            "deck" => self.deck = false,
            "transport" => self.transport = false,
            "scheduler" => self.scheduler = false,
            "loop" | "loops" => self.loop_events = false,
            "sync" => self.sync = false,
            "master" => self.master = false,
            _ => {}
        }
    }

    fn allows(&self, event: &EngineEvent) -> bool {
        match event {
            EngineEvent::DeckLoaded { .. } | EngineEvent::DeckUnloaded { .. } => self.deck,
            EngineEvent::TransportStarted { .. }
            | EngineEvent::TransportPaused { .. }
            | EngineEvent::TransportStopped { .. } => self.transport,
            EngineEvent::LoopChanged { .. } | EngineEvent::LoopCleared { .. } => self.loop_events,
            EngineEvent::SyncChanged { .. } => self.sync,
            EngineEvent::MasterBpmChanged { .. } => self.master,
            EngineEvent::ScheduledArmed { .. } | EngineEvent::ScheduledFired { .. } => {
                self.scheduler
            }
            EngineEvent::ClockTick { .. } => true,
        }
    }
}

async fn serve_lines(
    mut command_tx: rtrb::Producer<Command>,
    mut event_rx: rtrb::Consumer<EngineEvent>,
) -> anyhow::Result<()> {
    let stdin = BufReader::new(io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = io::stdout();
    let mut state = ServerState {
        subscriptions: EventSubscriptions::default(),
        next_subscription_id: 1,
    };
    let mut event_poll = time::interval(TokioDuration::from_millis(5));

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else {
                    break;
                };
                if line.trim().is_empty() {
                    continue;
                }
                let response = match serde_json::from_str::<RpcRequest>(&line) {
                    Ok(request) => handle_request(request, &mut command_tx, &mut state).await,
                    Err(err) => RpcResponse::err(None, -32_700, format!("parse error: {err}")),
                };
                let encoded = serde_json::to_string(&response)?;
                stdout.write_all(encoded.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await?;
            }
            _ = event_poll.tick() => {
                drain_events(&mut event_rx, &state.subscriptions, &mut stdout).await?;
            }
        }
    }

    Ok(())
}

async fn handle_request(
    request: RpcRequest,
    command_tx: &mut rtrb::Producer<Command>,
    state: &mut ServerState,
) -> RpcResponse {
    let id = request.id.clone();
    let result = match request.method.as_str() {
        "load" => load(request.params, command_tx).await,
        "load_track_analyze" | "get_analysis" | "get_waveform" | "analyze" => {
            analyze(request.params).await
        }
        "unload" => send_deck(request.params, command_tx, |deck_id| Command::Unload {
            deck_id,
        }),
        "play" => send_deck(request.params, command_tx, |deck_id| Command::Play {
            deck_id,
        }),
        "pause" => send_deck(request.params, command_tx, |deck_id| Command::Pause {
            deck_id,
        }),
        "stop" => send_deck(request.params, command_tx, |deck_id| Command::Stop {
            deck_id,
        }),
        "seek" | "seek_beat" => parse::<SeekBeatParams>(request.params).and_then(|params| {
            push(
                command_tx,
                Command::SeekBeat {
                    deck_id: params.deck_id,
                    beat: params.beat,
                },
            )
        }),
        "jump_beats" => parse::<JumpBeatsParams>(request.params).and_then(|params| {
            push(
                command_tx,
                Command::JumpBeats {
                    deck_id: params.deck_id,
                    beats: params.beats,
                },
            )
        }),
        "raw_seek_seconds" => parse::<RawSeekSecondsParams>(request.params).and_then(|params| {
            push(
                command_tx,
                Command::RawSeekSeconds {
                    deck_id: params.deck_id,
                    seconds: params.seconds,
                },
            )
        }),
        "set_volume" => parse::<SetVolumeParams>(request.params).and_then(|params| {
            push(
                command_tx,
                Command::SetVolume {
                    deck_id: params.deck_id,
                    volume: params.volume,
                },
            )
        }),
        "set_tempo" => parse::<SetTempoParams>(request.params).and_then(|params| {
            push(
                command_tx,
                Command::SetTempo {
                    deck_id: params.deck_id,
                    ratio: params.ratio,
                },
            )
        }),
        "set_original_bpm" => parse::<SetOriginalBpmParams>(request.params).and_then(|params| {
            push(
                command_tx,
                Command::SetOriginalBpm {
                    deck_id: params.deck_id,
                    bpm: params.bpm,
                },
            )
        }),
        "set_master" => send_deck(request.params, command_tx, |deck_id| Command::SetMaster {
            deck_id,
        }),
        "engage_sync" => send_deck(request.params, command_tx, |deck_id| Command::EngageSync {
            deck_id,
        }),
        "disengage_sync" => send_deck(request.params, command_tx, |deck_id| {
            Command::DisengageSync { deck_id }
        }),
        "raw_set_loop_seconds" => {
            parse::<RawSetLoopSecondsParams>(request.params).and_then(|params| {
                push(
                    command_tx,
                    Command::RawSetLoopSeconds {
                        deck_id: params.deck_id,
                        start_seconds: params.start_seconds,
                        end_seconds: params.end_seconds,
                        active: params.active,
                    },
                )
            })
        }
        "set_loop" | "set_loop_beats" | "set_loop_current" => {
            parse::<SetLoopBeatsParams>(request.params).and_then(|params| {
                push(
                    command_tx,
                    Command::SetLoopBeats {
                        deck_id: params.deck_id,
                        start_beat: params.start_beat,
                        length_beats: params.length_beats,
                    },
                )
            })
        }
        "clear_loop" => send_deck(request.params, command_tx, |deck_id| Command::ClearLoop {
            deck_id,
        }),
        "set_master_bpm" | "set_global_master_bpm" => parse::<SetMasterBpmParams>(request.params)
            .and_then(|params| push(command_tx, Command::SetMasterBpm { bpm: params.bpm })),
        "schedule" | "schedule_quantized" => schedule(request.params, command_tx),
        "quantized_play" => schedule_alias("play", request.params, command_tx),
        "quantized_pause" => schedule_alias("pause", request.params, command_tx),
        "quantized_stop" => schedule_alias("stop", request.params, command_tx),
        "quantized_seek" | "quantized_seek_beat" => {
            schedule_alias("seek_beat", request.params, command_tx)
        }
        "quantized_jump_beats" => schedule_alias("jump_beats", request.params, command_tx),
        "quantized_set_loop" | "quantized_set_loop_beats" | "quantized_set_loop_current" => {
            schedule_alias("set_loop_beats", request.params, command_tx)
        }
        "quantized_clear_loop" => schedule_alias("clear_loop", request.params, command_tx),
        "quantized_set_volume" => schedule_alias("set_volume", request.params, command_tx),
        "quantized_set_tempo" => schedule_alias("set_tempo", request.params, command_tx),
        "quantized_set_master_bpm" | "quantized_set_global_master_bpm" => {
            schedule_alias("set_master_bpm", request.params, command_tx)
        }
        "subscribe" => subscribe(request.params, state),
        "unsubscribe" => unsubscribe(request.params, state),
        "subscribe_clock" => subscribe_clock(request.params, command_tx, state),
        "unsubscribe_clock" => unsubscribe_clock(request.params, command_tx),
        "ping" => Ok(json!({"pong": true})),
        other => Err(anyhow!("unknown method {other}")),
    };

    match result {
        Ok(value) => RpcResponse::ok(id, value),
        Err(err) => RpcResponse::err(id, -32_000, err.to_string()),
    }
}

async fn load(params: Value, command_tx: &mut rtrb::Producer<Command>) -> anyhow::Result<Value> {
    let params = parse::<LoadParams>(params)?;
    let path = params.path.clone();
    let decoded = tokio::task::spawn_blocking({
        let path = path.clone();
        move || decode_file(Path::new(&path))
    })
    .await
    .context("load task failed")??;
    let bpm_hint = read_bpm_tag(&path).ok().flatten();

    let mono = to_mono(&decoded.samples, decoded.channels);
    let analysis = if params.analyze {
        Some(extract_beats_with_bpm_hint(
            &mono,
            decoded.sample_rate,
            bpm_hint,
        ))
    } else {
        None
    };
    let beat_grid = analysis
        .as_ref()
        .filter(|analysis| !analysis.beats.is_empty())
        .map(|analysis| BeatGrid::new(analysis.beats.clone()));
    let original_bpm = analysis.as_ref().and_then(|analysis| {
        (analysis.bpm.is_finite() && analysis.bpm > 0.0).then_some(f64::from(analysis.bpm))
    });
    let deck_id = params.deck_id.unwrap_or(0);
    let track = DecodedTrack::new(
        decoded.sample_rate,
        decoded.channels,
        decoded.samples,
        beat_grid,
        original_bpm,
    );
    push(command_tx, Command::Load { deck_id, track })?;

    Ok(serde_json::to_value(LoadResult {
        deck_id,
        sample_rate: decoded.sample_rate,
        channels: decoded.channels,
        frames: decoded.frames,
        bpm: analysis.as_ref().map(|analysis| analysis.bpm),
        beats: analysis.map(|analysis| analysis.beats).unwrap_or_default(),
    })?)
}

fn schedule(params: Value, command_tx: &mut rtrb::Producer<Command>) -> anyhow::Result<Value> {
    let params = parse::<ScheduleParams>(params)?;
    schedule_command(
        &params.action,
        params.params,
        params.quantize,
        params.offset_beats,
        command_tx,
    )
}

fn schedule_alias(
    action: &'static str,
    params: Value,
    command_tx: &mut rtrb::Producer<Command>,
) -> anyhow::Result<Value> {
    let mut params = match params {
        Value::Object(params) => params,
        Value::Null => serde_json::Map::new(),
        _ => return Err(anyhow!("invalid params")),
    };
    let quantize = params
        .remove("quantize")
        .map(parse)
        .transpose()?
        .unwrap_or_default();
    let offset_beats = params
        .remove("offset_beats")
        .map(parse)
        .transpose()?
        .unwrap_or(0.0);
    schedule_command(
        action,
        Value::Object(params),
        quantize,
        offset_beats,
        command_tx,
    )
}

fn schedule_command(
    action: &str,
    params: Value,
    quantize: djengine_audio::QuantizeMode,
    offset_beats: f64,
    command_tx: &mut rtrb::Producer<Command>,
) -> anyhow::Result<Value> {
    let command = scheduled_inner_command(action, params)?;
    push(
        command_tx,
        Command::Schedule {
            quantize,
            offset_beats,
            command: Box::new(command),
        },
    )
}

fn scheduled_inner_command(action: &str, params: Value) -> anyhow::Result<Command> {
    match action {
        "play" => parse::<DeckParams>(params).map(|params| Command::Play {
            deck_id: params.deck_id,
        }),
        "pause" => parse::<DeckParams>(params).map(|params| Command::Pause {
            deck_id: params.deck_id,
        }),
        "stop" => parse::<DeckParams>(params).map(|params| Command::Stop {
            deck_id: params.deck_id,
        }),
        "seek" | "seek_beat" => parse::<SeekBeatParams>(params).map(|params| Command::SeekBeat {
            deck_id: params.deck_id,
            beat: params.beat,
        }),
        "jump_beats" => parse::<JumpBeatsParams>(params).map(|params| Command::JumpBeats {
            deck_id: params.deck_id,
            beats: params.beats,
        }),
        "set_volume" => parse::<SetVolumeParams>(params).map(|params| Command::SetVolume {
            deck_id: params.deck_id,
            volume: params.volume,
        }),
        "set_tempo" => parse::<SetTempoParams>(params).map(|params| Command::SetTempo {
            deck_id: params.deck_id,
            ratio: params.ratio,
        }),
        "set_master" => parse::<DeckParams>(params).map(|params| Command::SetMaster {
            deck_id: params.deck_id,
        }),
        "set_loop" | "set_loop_beats" | "set_loop_current" => parse::<SetLoopBeatsParams>(params)
            .map(|params| Command::SetLoopBeats {
                deck_id: params.deck_id,
                start_beat: params.start_beat,
                length_beats: params.length_beats,
            }),
        "clear_loop" => parse::<DeckParams>(params).map(|params| Command::ClearLoop {
            deck_id: params.deck_id,
        }),
        "set_master_bpm" | "set_global_master_bpm" => parse::<SetMasterBpmParams>(params)
            .map(|params| Command::SetMasterBpm { bpm: params.bpm }),
        other => Err(anyhow!("unsupported scheduled action {other}")),
    }
}

fn subscribe(params: Value, state: &mut ServerState) -> anyhow::Result<Value> {
    let params = parse::<SubscribeParams>(params)?;
    let events = if params.events.is_empty() {
        vec!["all".to_string()]
    } else {
        params.events
    };
    for event in &events {
        state.subscriptions.subscribe(event);
    }
    Ok(json!({ "events": events }))
}

fn unsubscribe(params: Value, state: &mut ServerState) -> anyhow::Result<Value> {
    let params = parse::<SubscribeParams>(params)?;
    let events = if params.events.is_empty() {
        vec!["all".to_string()]
    } else {
        params.events
    };
    for event in &events {
        state.subscriptions.unsubscribe(event);
    }
    Ok(json!({ "events": events }))
}

fn subscribe_clock(
    params: Value,
    command_tx: &mut rtrb::Producer<Command>,
    state: &mut ServerState,
) -> anyhow::Result<Value> {
    let params = parse::<SubscribeClockParams>(params)?;
    if params.interval_beats.is_some() && params.subdivisions_per_beat.is_some() {
        return Err(anyhow!(
            "use either interval_beats or subdivisions_per_beat, not both"
        ));
    }
    let interval_beats = match (params.interval_beats, params.subdivisions_per_beat) {
        (Some(interval), None) => interval,
        (None, Some(subdivisions)) if subdivisions > 0 => 1.0 / f64::from(subdivisions),
        (None, None) => 1.0,
        _ => return Err(anyhow!("invalid clock subscription")),
    };
    if !interval_beats.is_finite() || interval_beats <= 0.0 {
        return Err(anyhow!("invalid clock interval"));
    }

    if state.next_subscription_id == 0 {
        state.next_subscription_id = 1;
    }
    let subscription_id = state.next_subscription_id;
    state.next_subscription_id = state.next_subscription_id.saturating_add(1);
    push(
        command_tx,
        Command::SetClockSubscription {
            subscription_id,
            interval_beats,
        },
    )?;
    Ok(json!({
        "subscription_id": subscription_id,
        "interval_beats": interval_beats
    }))
}

fn unsubscribe_clock(
    params: Value,
    command_tx: &mut rtrb::Producer<Command>,
) -> anyhow::Result<Value> {
    let params = parse::<UnsubscribeClockParams>(params)?;
    push(
        command_tx,
        Command::ClearClockSubscription {
            subscription_id: params.subscription_id,
        },
    )
}

async fn drain_events(
    event_rx: &mut rtrb::Consumer<EngineEvent>,
    subscriptions: &EventSubscriptions,
    stdout: &mut io::Stdout,
) -> anyhow::Result<()> {
    let mut wrote = false;
    while let Ok(event) = event_rx.pop() {
        if !subscriptions.allows(&event) {
            continue;
        }
        let notification = RpcNotification {
            method: "event".to_string(),
            params: serde_json::to_value(event)?,
        };
        let encoded = serde_json::to_string(&notification)?;
        stdout.write_all(encoded.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        wrote = true;
    }
    if wrote {
        stdout.flush().await?;
    }
    Ok(())
}

async fn analyze(params: Value) -> anyhow::Result<Value> {
    let params = parse::<AnalyzeParams>(params)?;
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<AnalysisResult> {
        let bpm_hint = read_bpm_tag(&params.path).ok().flatten();
        let decoded = decode_file(&params.path)?;
        let mono = to_mono(&decoded.samples, decoded.channels);
        let beats = extract_beats_with_bpm_hint(&mono, decoded.sample_rate, bpm_hint);
        let peaks = extract_peaks(&decoded.samples, decoded.channels, params.peak_points);
        let waveform_levels = waveform_levels(
            &decoded.samples,
            decoded.channels,
            &params.waveform_levels,
            params.peak_points,
        );
        Ok(AnalysisResult {
            sample_rate: decoded.sample_rate,
            channels: decoded.channels,
            frames: decoded.frames,
            duration_seconds: decoded.frames as f64 / f64::from(decoded.sample_rate.max(1)),
            bpm: beats.bpm,
            beats: beats.beats,
            peaks,
            waveform_levels,
        })
    })
    .await
    .context("analysis task failed")??;
    Ok(serde_json::to_value(result)?)
}

fn send_deck(
    params: Value,
    command_tx: &mut rtrb::Producer<Command>,
    make: impl FnOnce(usize) -> Command,
) -> anyhow::Result<Value> {
    let params = parse::<DeckParams>(params)?;
    push(command_tx, make(params.deck_id))?;
    Ok(Value::Bool(true))
}

fn parse<T: DeserializeOwned>(value: Value) -> anyhow::Result<T> {
    serde_json::from_value(value).context("invalid params")
}

fn push(command_tx: &mut rtrb::Producer<Command>, command: Command) -> anyhow::Result<Value> {
    command_tx
        .push(command)
        .map_err(|_| anyhow!("audio command queue is full"))?;
    Ok(Value::Bool(true))
}

fn to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32)
        .collect()
}

fn waveform_levels(
    samples: &[f32],
    channels: usize,
    requested_levels: &[usize],
    fallback_points: usize,
) -> Vec<WaveformLevel> {
    let mut levels = if requested_levels.is_empty() {
        vec![fallback_points.max(1)]
    } else {
        requested_levels
            .iter()
            .copied()
            .filter(|points| *points > 0)
            .collect()
    };
    levels.sort_unstable();
    levels.dedup();
    levels
        .into_iter()
        .map(|points| WaveformLevel {
            points,
            peaks: extract_peaks(samples, channels, points),
        })
        .collect()
}

fn spawn_tick_writer(
    mut telemetry_rx: rtrb::Consumer<Tick>,
) -> Option<(Arc<AtomicBool>, thread::JoinHandle<()>)> {
    let path = std::env::var("DJENGINE_TICK_RING_PATH").ok()?;
    let capacity = std::env::var("DJENGINE_TICK_RING_CAPACITY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(4096);
    let (ready_tx, ready_rx) = mpsc::channel();
    let running = Arc::new(AtomicBool::new(true));
    let thread_running = Arc::clone(&running);
    let handle = thread::spawn(move || {
        let mut ring = match TickRing::create(path, capacity) {
            Ok(ring) => {
                let _ = ready_tx.send(Ok(()));
                ring
            }
            Err(err) => {
                let _ = ready_tx.send(Err(err.to_string()));
                return;
            }
        };
        while thread_running.load(Ordering::Acquire) {
            match telemetry_rx.pop() {
                Ok(tick) => {
                    let _ = ring.push(tick);
                }
                Err(rtrb::PopError::Empty) => thread::sleep(Duration::from_millis(5)),
            }
        }
        let _ = ring.flush();
    });
    match ready_rx.recv() {
        Ok(Ok(())) => Some((running, handle)),
        Ok(Err(_)) | Err(_) => {
            running.store(false, Ordering::Release);
            let _ = handle.join();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::protocol::RpcRequest;

    use super::{handle_request, ServerState};

    const SAMPLE_RATE: u32 = 48_000;

    fn temp_wav_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "djengine-rpc-{name}-{}-{}.wav",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ))
    }

    fn click_track_wav(bpm: f32, seconds: f32) -> Vec<u8> {
        let frames = (SAMPLE_RATE as f32 * seconds).round() as usize;
        let interval = 60.0 / bpm;
        let mut samples = vec![0_i16; frames];
        let mut beat_time = 0.0;
        while beat_time < seconds {
            let start = (beat_time * SAMPLE_RATE as f32).round() as usize;
            for offset in 0..128 {
                if start + offset < samples.len() {
                    let gain = 1.0 - offset as f32 / 128.0;
                    samples[start + offset] = (gain * i16::MAX as f32) as i16;
                }
            }
            beat_time += interval;
        }

        let data_len = (samples.len() * 2) as u32;
        let mut bytes = Vec::with_capacity(44 + data_len as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        bytes.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    #[tokio::test]
    async fn analyze_returns_requested_waveform_levels() {
        let path = temp_wav_path("waveform-levels");
        std::fs::write(&path, click_track_wav(120.0, 4.0)).unwrap();

        let (mut command_tx, _command_rx) = rtrb::RingBuffer::<djengine_audio::Command>::new(1);
        let mut state = ServerState::default();
        let response = handle_request(
            RpcRequest {
                id: Some(json!(1)),
                method: "get_waveform".to_string(),
                params: json!({
                    "path": path,
                    "peak_points": 16,
                    "waveform_levels": [64, 16, 64]
                }),
            },
            &mut command_tx,
            &mut state,
        )
        .await;

        let _ = std::fs::remove_file(path);
        assert!(response.error.is_none());
        let result = response.result.unwrap();
        assert_eq!(result["sample_rate"], SAMPLE_RATE);
        assert_eq!(result["duration_seconds"], 4.0);
        assert_eq!(result["peaks"].as_array().unwrap().len(), 16);

        let levels = result["waveform_levels"].as_array().unwrap();
        assert_eq!(levels.len(), 2);
        assert_eq!(levels[0]["points"], 16);
        assert_eq!(levels[0]["peaks"].as_array().unwrap().len(), 16);
        assert_eq!(levels[1]["points"], 64);
        assert_eq!(levels[1]["peaks"].as_array().unwrap().len(), 64);
    }

    #[tokio::test]
    async fn quantized_stop_enqueues_scheduled_stop() {
        let (mut command_tx, mut command_rx) = rtrb::RingBuffer::<djengine_audio::Command>::new(1);
        let mut state = ServerState::default();
        let response = handle_request(
            RpcRequest {
                id: Some(json!(2)),
                method: "quantized_stop".to_string(),
                params: json!({
                    "deck_id": 3,
                    "quantize": "bar",
                    "offset_beats": 4.0
                }),
            },
            &mut command_tx,
            &mut state,
        )
        .await;

        assert!(response.error.is_none());
        let command = command_rx.pop().unwrap();
        let djengine_audio::Command::Schedule {
            quantize,
            offset_beats,
            command,
        } = command
        else {
            panic!("expected scheduled command");
        };
        assert_eq!(quantize, djengine_audio::QuantizeMode::Bar);
        assert_eq!(offset_beats, 4.0);
        let djengine_audio::Command::Stop { deck_id } = *command else {
            panic!("expected scheduled stop");
        };
        assert_eq!(deck_id, 3);
    }

    #[tokio::test]
    async fn subscribe_clock_enqueues_clock_subscription() {
        let (mut command_tx, mut command_rx) = rtrb::RingBuffer::<djengine_audio::Command>::new(1);
        let mut state = ServerState::default();
        let response = handle_request(
            RpcRequest {
                id: Some(json!(3)),
                method: "subscribe_clock".to_string(),
                params: json!({
                    "subdivisions_per_beat": 8
                }),
            },
            &mut command_tx,
            &mut state,
        )
        .await;

        assert!(response.error.is_none());
        let result = response.result.unwrap();
        assert_eq!(result["subscription_id"], 1);
        assert_eq!(result["interval_beats"], 0.125);

        let command = command_rx.pop().unwrap();
        let djengine_audio::Command::SetClockSubscription {
            subscription_id,
            interval_beats,
        } = command
        else {
            panic!("expected clock subscription command");
        };
        assert_eq!(subscription_id, 1);
        assert_eq!(interval_beats, 0.125);
    }
}
