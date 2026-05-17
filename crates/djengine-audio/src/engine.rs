use djengine_core::beat_grid::next_downbeat_after_beat;
use djengine_core::{DeckPosition, GlobalClock};
use rtrb::{Consumer, Producer};

use crate::commands::{Command, DeckId, QuantizeMode};
use crate::deck::{Deck, DecodedTrack};
use crate::telemetry::Tick;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub device_sample_rate: u32,
    pub output_channels: usize,
    pub max_decks: usize,
    pub telemetry_hz: u32,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            device_sample_rate: 48_000,
            output_channels: 2,
            max_decks: 32,
            telemetry_hz: 60,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("invalid deck id {0}")]
    InvalidDeck(DeckId),
    #[error("deck slot {0} is empty")]
    EmptyDeck(DeckId),
    #[error("no free deck slots")]
    NoFreeDeck,
    #[error("deck is missing a beat grid")]
    MissingBeatGrid,
    #[error("invalid master BPM")]
    InvalidMasterBpm,
    #[error("invalid beat command")]
    InvalidBeatCommand,
    #[error("invalid scheduled command")]
    InvalidScheduledCommand,
}

#[derive(Debug, Clone, Copy)]
pub struct GlobalMaster {
    bpm: f64,
    anchor_global_frame: u64,
    anchor_beat: f64,
    beats_per_bar: u32,
}

impl GlobalMaster {
    pub fn new(bpm: f64) -> Self {
        Self {
            bpm,
            anchor_global_frame: 0,
            anchor_beat: 0.0,
            beats_per_bar: 4,
        }
    }

    pub fn bpm(&self) -> f64 {
        self.bpm
    }

    pub fn beat_at(&self, global_frame: u64, device_sample_rate: u32) -> f64 {
        self.anchor_beat
            + (global_frame as f64 - self.anchor_global_frame as f64) * self.bpm
                / (60.0 * f64::from(device_sample_rate.max(1)))
    }

    pub fn set_bpm_preserving_phase(
        &mut self,
        bpm: f64,
        global_frame: u64,
        device_sample_rate: u32,
    ) -> Result<(), EngineError> {
        if !bpm.is_finite() || bpm <= 0.0 {
            return Err(EngineError::InvalidMasterBpm);
        }
        let beat = self.beat_at(global_frame, device_sample_rate);
        self.bpm = bpm;
        self.anchor_global_frame = global_frame;
        self.anchor_beat = beat;
        Ok(())
    }
}

pub struct Engine {
    config: EngineConfig,
    clock: GlobalClock,
    decks: Vec<Option<Deck>>,
    global_master: GlobalMaster,
    command_rx: Option<Consumer<Command>>,
    telemetry_tx: Option<Producer<Tick>>,
    tick_interval_frames: u64,
    scheduled_commands: Vec<ScheduledCommand>,
}

#[derive(Debug, Clone)]
struct ScheduledCommand {
    target_global_frame: u64,
    command: Command,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Self {
        let max_decks = config.max_decks.max(16);
        let tick_interval_frames =
            (u64::from(config.device_sample_rate) / u64::from(config.telemetry_hz.max(1))).max(1);
        Self {
            config,
            clock: GlobalClock::new(),
            decks: (0..max_decks).map(|_| None).collect(),
            global_master: GlobalMaster::new(120.0),
            command_rx: None,
            telemetry_tx: None,
            tick_interval_frames,
            scheduled_commands: Vec::with_capacity(128),
        }
    }

    pub fn with_rings(
        config: EngineConfig,
        command_rx: Consumer<Command>,
        telemetry_tx: Producer<Tick>,
    ) -> Self {
        let mut engine = Self::new(config);
        engine.command_rx = Some(command_rx);
        engine.telemetry_tx = Some(telemetry_tx);
        engine
    }

    pub fn clock(&self) -> &GlobalClock {
        &self.clock
    }

    pub fn current_global_frame(&self) -> u64 {
        self.clock.load()
    }

    pub fn config(&self) -> &EngineConfig {
        &self.config
    }

    pub fn load_track(&mut self, track: DecodedTrack) -> Result<DeckId, EngineError> {
        let deck_id = self
            .decks
            .iter()
            .position(Option::is_none)
            .ok_or(EngineError::NoFreeDeck)?;
        self.load_track_at(deck_id, track)?;
        Ok(deck_id)
    }

    pub fn load_track_at(
        &mut self,
        deck_id: DeckId,
        track: DecodedTrack,
    ) -> Result<(), EngineError> {
        self.ensure_slot(deck_id)?;
        let deck = Deck::new(track, self.config.device_sample_rate, self.clock.load());
        self.decks[deck_id] = Some(deck);
        Ok(())
    }

    pub fn unload(&mut self, deck_id: DeckId) -> Result<(), EngineError> {
        self.ensure_slot(deck_id)?;
        self.decks[deck_id] = None;
        Ok(())
    }

    pub fn deck(&self, deck_id: DeckId) -> Option<&Deck> {
        self.decks.get(deck_id).and_then(Option::as_ref)
    }

    pub fn deck_mut(&mut self, deck_id: DeckId) -> Option<&mut Deck> {
        self.decks.get_mut(deck_id).and_then(Option::as_mut)
    }

    pub fn deck_position(&self, deck_id: DeckId) -> Option<DeckPosition> {
        self.deck(deck_id).map(|deck| deck.position)
    }

    pub fn set_master(&mut self, deck_id: DeckId) -> Result<(), EngineError> {
        self.require_deck(deck_id)?;
        let current = self.clock.load();
        let deck = self.deck(deck_id).ok_or(EngineError::EmptyDeck(deck_id))?;
        let bpm = deck.original_bpm() * deck.ratio();
        let beat = deck
            .track
            .beat_grid
            .as_ref()
            .and_then(|grid| {
                grid.beat_at_time(deck.source_frame_at(current) / f64::from(deck.track.sample_rate))
            })
            .unwrap_or_else(|| {
                self.global_master
                    .beat_at(current, self.config.device_sample_rate)
            });
        let beats_per_bar = deck
            .track
            .beat_grid
            .as_ref()
            .map(|grid| grid.beats_per_bar)
            .unwrap_or(4);
        self.global_master.bpm = bpm;
        self.global_master.anchor_global_frame = current;
        self.global_master.anchor_beat = beat;
        self.global_master.beats_per_bar = beats_per_bar;
        self.update_synced_ratios(current);
        Ok(())
    }

    pub fn set_master_bpm(&mut self, bpm: Option<f64>) -> Result<(), EngineError> {
        let current = self.clock.load();
        self.global_master.set_bpm_preserving_phase(
            bpm.unwrap_or(120.0),
            current,
            self.config.device_sample_rate,
        )?;
        self.update_synced_ratios(current);
        Ok(())
    }

    pub fn effective_master_bpm(&self) -> Option<f64> {
        Some(self.global_master.bpm())
    }

    pub fn global_master(&self) -> GlobalMaster {
        self.global_master
    }

    pub fn engage_sync(&mut self, deck_id: DeckId) -> Result<(), EngineError> {
        self.require_deck(deck_id)?;

        let current_global_frame = self.clock.load();
        let master_beat = self
            .global_master
            .beat_at(current_global_frame, self.config.device_sample_rate);
        let target_master_beat =
            next_downbeat_after_beat(master_beat, self.global_master.beats_per_bar);
        let frames_until_target =
            (target_master_beat - master_beat) * 60.0 * f64::from(self.config.device_sample_rate)
                / self.global_master.bpm();
        let target_global_frame =
            current_global_frame.saturating_add(frames_until_target.round().max(0.0) as u64);

        let (
            follower_grid,
            follower_source_frame,
            follower_source_sample_rate,
            follower_original_bpm,
        ) = {
            let follower = self.deck(deck_id).ok_or(EngineError::EmptyDeck(deck_id))?;
            let follower_grid = follower
                .track
                .beat_grid
                .clone()
                .ok_or(EngineError::MissingBeatGrid)?;
            (
                follower_grid,
                follower.source_frame_at(current_global_frame).max(0.0),
                f64::from(follower.track.sample_rate.max(1)),
                follower.original_bpm(),
            )
        };

        let follower_time = follower_source_frame / follower_source_sample_rate;
        let follower_beat = follower_grid
            .beat_at_time(follower_time)
            .ok_or(EngineError::MissingBeatGrid)?;
        let target_follower_beat =
            next_downbeat_after_beat(follower_beat, follower_grid.beats_per_bar.max(1));
        let target_follower_time = follower_grid
            .time_at_beat(target_follower_beat)
            .ok_or(EngineError::MissingBeatGrid)?;
        let follower_ratio = self.global_master.bpm() / follower_original_bpm;

        let follower = self
            .deck_mut(deck_id)
            .ok_or(EngineError::EmptyDeck(deck_id))?;
        follower.seek_source_frame_at_global(
            (target_follower_time * follower_source_sample_rate)
                .round()
                .max(0.0),
            target_global_frame,
        );
        follower.set_ratio(follower_ratio, target_global_frame);
        follower.synced_to_master = true;
        follower.playing = true;
        Ok(())
    }

    pub fn disengage_sync(&mut self, deck_id: DeckId) -> Result<(), EngineError> {
        let current = self.clock.load();
        let deck = self
            .deck_mut(deck_id)
            .ok_or(EngineError::EmptyDeck(deck_id))?;
        deck.position.anchor_at(current);
        deck.synced_to_master = false;
        Ok(())
    }

    pub fn seek_beat(&mut self, deck_id: DeckId, beat: f64) -> Result<(), EngineError> {
        if !beat.is_finite() || beat < 0.0 {
            return Err(EngineError::InvalidBeatCommand);
        }
        let current = self.clock.load();
        let (source_frame, target_global_frame) = {
            let deck = self.deck(deck_id).ok_or(EngineError::EmptyDeck(deck_id))?;
            let grid = deck
                .track
                .beat_grid
                .as_ref()
                .ok_or(EngineError::MissingBeatGrid)?;
            let source_seconds = grid
                .time_at_beat(beat)
                .ok_or(EngineError::InvalidBeatCommand)?;
            let target_global_frame = if deck.synced_to_master {
                self.next_global_frame_for_beat_phase(beat, current)
            } else {
                current
            };
            (
                source_seconds * f64::from(deck.track.sample_rate.max(1)),
                target_global_frame,
            )
        };
        self.deck_mut(deck_id)
            .ok_or(EngineError::EmptyDeck(deck_id))?
            .seek_source_frame_at_global(source_frame.round().max(0.0), target_global_frame);
        Ok(())
    }

    pub fn jump_beats(&mut self, deck_id: DeckId, beats: f64) -> Result<(), EngineError> {
        if !beats.is_finite() {
            return Err(EngineError::InvalidBeatCommand);
        }
        let current = self.clock.load();
        let (target_beat, synced) = {
            let deck = self.deck(deck_id).ok_or(EngineError::EmptyDeck(deck_id))?;
            let current_beat = self
                .deck_beat_at(deck_id, current)
                .ok_or(EngineError::MissingBeatGrid)?;
            (current_beat + beats, deck.synced_to_master)
        };
        if synced && (beats - beats.round()).abs() > 1.0e-9 {
            return Err(EngineError::InvalidBeatCommand);
        }

        let source_frame = {
            let deck = self.deck(deck_id).ok_or(EngineError::EmptyDeck(deck_id))?;
            let grid = deck
                .track
                .beat_grid
                .as_ref()
                .ok_or(EngineError::MissingBeatGrid)?;
            let source_seconds = grid
                .time_at_beat(target_beat.max(0.0))
                .ok_or(EngineError::InvalidBeatCommand)?;
            source_seconds * f64::from(deck.track.sample_rate.max(1))
        };
        self.deck_mut(deck_id)
            .ok_or(EngineError::EmptyDeck(deck_id))?
            .seek_source_frame_at_global(source_frame.round().max(0.0), current);
        Ok(())
    }

    pub fn set_loop_beats(
        &mut self,
        deck_id: DeckId,
        start_beat: Option<f64>,
        length_beats: f64,
    ) -> Result<(), EngineError> {
        if !length_beats.is_finite() || length_beats <= 0.0 {
            return Err(EngineError::InvalidBeatCommand);
        }
        let current = self.clock.load();
        let (start_seconds, end_seconds) = {
            let deck = self.deck(deck_id).ok_or(EngineError::EmptyDeck(deck_id))?;
            let grid = deck
                .track
                .beat_grid
                .as_ref()
                .ok_or(EngineError::MissingBeatGrid)?;
            let start_beat = match start_beat {
                Some(beat) if beat.is_finite() && beat >= 0.0 => beat,
                Some(_) => return Err(EngineError::InvalidBeatCommand),
                None => {
                    let current_beat = self
                        .deck_beat_at(deck_id, current)
                        .ok_or(EngineError::MissingBeatGrid)?;
                    current_beat.round().max(0.0)
                }
            };
            let start_seconds = grid
                .time_at_beat(start_beat)
                .ok_or(EngineError::InvalidBeatCommand)?;
            let end_seconds = grid
                .time_at_beat(start_beat + length_beats)
                .ok_or(EngineError::InvalidBeatCommand)?;
            (start_seconds, end_seconds)
        };
        self.deck_mut(deck_id)
            .ok_or(EngineError::EmptyDeck(deck_id))?
            .set_loop(start_seconds, end_seconds, true);
        Ok(())
    }

    pub fn handle_command(&mut self, command: Command) -> Result<(), EngineError> {
        let current = self.clock.load();
        match command {
            Command::Load { deck_id, track } => self.load_track_at(deck_id, track),
            Command::Unload { deck_id } => self.unload(deck_id),
            Command::Play { deck_id } => {
                self.deck_mut(deck_id)
                    .ok_or(EngineError::EmptyDeck(deck_id))?
                    .play(current);
                Ok(())
            }
            Command::Pause { deck_id } => {
                self.deck_mut(deck_id)
                    .ok_or(EngineError::EmptyDeck(deck_id))?
                    .pause(current);
                Ok(())
            }
            Command::Stop { deck_id } => {
                self.deck_mut(deck_id)
                    .ok_or(EngineError::EmptyDeck(deck_id))?
                    .stop(current);
                Ok(())
            }
            Command::SeekBeat { deck_id, beat } => self.seek_beat(deck_id, beat),
            Command::JumpBeats { deck_id, beats } => self.jump_beats(deck_id, beats),
            Command::RawSeekSeconds { deck_id, seconds } => {
                self.deck_mut(deck_id)
                    .ok_or(EngineError::EmptyDeck(deck_id))?
                    .seek_seconds(seconds, current);
                Ok(())
            }
            Command::SetVolume { deck_id, volume } => {
                self.deck(deck_id)
                    .ok_or(EngineError::EmptyDeck(deck_id))?
                    .set_volume(volume);
                Ok(())
            }
            Command::SetTempo { deck_id, ratio } => {
                self.deck_mut(deck_id)
                    .ok_or(EngineError::EmptyDeck(deck_id))?
                    .set_ratio(ratio, current);
                Ok(())
            }
            Command::SetOriginalBpm { deck_id, bpm } => {
                self.deck_mut(deck_id)
                    .ok_or(EngineError::EmptyDeck(deck_id))?
                    .set_original_bpm(bpm);
                Ok(())
            }
            Command::SetMaster { deck_id } => self.set_master(deck_id),
            Command::EngageSync { deck_id } => self.engage_sync(deck_id),
            Command::DisengageSync { deck_id } => self.disengage_sync(deck_id),
            Command::RawSetLoopSeconds {
                deck_id,
                start_seconds,
                end_seconds,
                active,
            } => {
                self.deck_mut(deck_id)
                    .ok_or(EngineError::EmptyDeck(deck_id))?
                    .set_loop(start_seconds, end_seconds, active);
                Ok(())
            }
            Command::SetLoopBeats {
                deck_id,
                start_beat,
                length_beats,
            } => self.set_loop_beats(deck_id, start_beat, length_beats),
            Command::ClearLoop { deck_id } => {
                self.deck_mut(deck_id)
                    .ok_or(EngineError::EmptyDeck(deck_id))?
                    .clear_loop();
                Ok(())
            }
            Command::SetMasterBpm { bpm } => self.set_master_bpm(bpm),
            Command::Schedule {
                quantize,
                offset_beats,
                command,
            } => self.schedule_command(quantize, offset_beats, *command),
        }
    }

    pub fn process_offline(&mut self, frames: usize, output: &mut [f32]) {
        let wanted = frames * self.config.output_channels;
        let samples = wanted.min(output.len());
        self.process(&mut output[..samples]);
    }

    pub fn process(&mut self, output: &mut [f32]) {
        self.drain_commands();
        output.fill(0.0);

        let channels = self.config.output_channels.max(1);
        let frames = output.len() / channels;
        let mut rendered = 0usize;
        while rendered < frames {
            let global_start = self.clock.load();
            self.apply_due_scheduled(global_start);
            let remaining = frames - rendered;
            let chunk_frames = self.frames_until_next_scheduled(global_start, remaining);
            let start = rendered * channels;
            let end = start + chunk_frames * channels;

            for deck in self.decks.iter_mut().flatten() {
                deck.render_add(global_start, channels, &mut output[start..end]);
            }

            self.emit_ticks(global_start);
            self.clock.advance(chunk_frames as u64);
            rendered += chunk_frames;
        }

        self.apply_due_scheduled(self.clock.load());
    }

    pub fn phase_difference_samples(&self, deck_id: DeckId, global_frame: u64) -> Option<i64> {
        let deck = self.deck(deck_id)?;
        let deck_grid = deck.track.beat_grid.as_ref()?;
        let deck_time = deck.source_frame_at(global_frame) / f64::from(deck.track.sample_rate);
        let master_phase = self
            .global_master
            .beat_at(global_frame, self.config.device_sample_rate)
            .rem_euclid(1.0);
        let deck_phase = deck_grid.beat_at_time(deck_time)?.rem_euclid(1.0);
        let mut diff_beats = deck_phase - master_phase;
        if diff_beats > 0.5 {
            diff_beats -= 1.0;
        } else if diff_beats < -0.5 {
            diff_beats += 1.0;
        }
        Some(
            (diff_beats * 60.0 / self.global_master.bpm()
                * f64::from(self.config.device_sample_rate))
            .round() as i64,
        )
    }

    fn update_synced_ratios(&mut self, global_frame: u64) {
        let bpm = self.global_master.bpm();
        for deck in self.decks.iter_mut().flatten() {
            if deck.synced_to_master {
                deck.set_ratio(bpm / deck.original_bpm(), global_frame);
            }
        }
    }

    fn deck_beat_at(&self, deck_id: DeckId, global_frame: u64) -> Option<f64> {
        let deck = self.deck(deck_id)?;
        let grid = deck.track.beat_grid.as_ref()?;
        let source_seconds = deck.source_frame_at(global_frame) / f64::from(deck.track.sample_rate);
        grid.beat_at_time(source_seconds)
    }

    fn next_global_frame_for_beat_phase(&self, beat: f64, current_global_frame: u64) -> u64 {
        let current_master_beat = self
            .global_master
            .beat_at(current_global_frame, self.config.device_sample_rate);
        let target_phase = beat.rem_euclid(1.0);
        let mut target_master_beat = current_master_beat.floor() + target_phase;
        if target_master_beat < current_master_beat - 1.0e-9 {
            target_master_beat += 1.0;
        }
        let frames_until = (target_master_beat - current_master_beat).max(0.0)
            * 60.0
            * f64::from(self.config.device_sample_rate)
            / self.global_master.bpm();
        current_global_frame.saturating_add(frames_until.round() as u64)
    }

    fn schedule_command(
        &mut self,
        quantize: QuantizeMode,
        offset_beats: f64,
        command: Command,
    ) -> Result<(), EngineError> {
        if !offset_beats.is_finite() || offset_beats < 0.0 {
            return Err(EngineError::InvalidScheduledCommand);
        }
        if matches!(command, Command::Load { .. } | Command::Schedule { .. }) {
            return Err(EngineError::InvalidScheduledCommand);
        }

        let target_global_frame = self.next_global_frame_for_quantize(quantize, offset_beats)?;
        self.scheduled_commands.push(ScheduledCommand {
            target_global_frame,
            command,
        });
        Ok(())
    }

    fn next_global_frame_for_quantize(
        &self,
        quantize: QuantizeMode,
        offset_beats: f64,
    ) -> Result<u64, EngineError> {
        let current_global_frame = self.clock.load();
        let current_beat = self
            .global_master
            .beat_at(current_global_frame, self.config.device_sample_rate);
        if !current_beat.is_finite() || self.global_master.bpm() <= 0.0 {
            return Err(EngineError::InvalidScheduledCommand);
        }

        let boundary_beat = match quantize {
            QuantizeMode::Beat => current_beat.floor() + 1.0,
            QuantizeMode::Bar => {
                next_downbeat_after_beat(current_beat, self.global_master.beats_per_bar)
            }
        };
        let target_beat = boundary_beat + offset_beats;
        let frames_until = (target_beat - current_beat).max(0.0)
            * 60.0
            * f64::from(self.config.device_sample_rate)
            / self.global_master.bpm();
        if !frames_until.is_finite() {
            return Err(EngineError::InvalidScheduledCommand);
        }
        Ok(current_global_frame.saturating_add(frames_until.round() as u64))
    }

    fn frames_until_next_scheduled(&self, global_start: u64, remaining_frames: usize) -> usize {
        let Some(next) = self
            .scheduled_commands
            .iter()
            .filter_map(|scheduled| {
                (scheduled.target_global_frame > global_start)
                    .then_some(scheduled.target_global_frame)
            })
            .min()
        else {
            return remaining_frames;
        };

        let frames = next.saturating_sub(global_start) as usize;
        frames.clamp(1, remaining_frames)
    }

    fn apply_due_scheduled(&mut self, global_frame: u64) {
        let mut index = 0usize;
        while index < self.scheduled_commands.len() {
            if self.scheduled_commands[index].target_global_frame <= global_frame {
                let scheduled = self.scheduled_commands.remove(index);
                let _ = self.handle_command(scheduled.command);
            } else {
                index += 1;
            }
        }
    }

    fn drain_commands(&mut self) {
        let Some(mut rx) = self.command_rx.take() else {
            return;
        };
        while let Ok(command) = rx.pop() {
            let _ = self.handle_command(command);
        }
        self.command_rx = Some(rx);
    }

    fn emit_ticks(&mut self, global_start: u64) {
        let Some(mut tx) = self.telemetry_tx.take() else {
            return;
        };
        let tick_interval_frames = self.tick_interval_frames;
        let global_master_beat = self
            .global_master
            .beat_at(global_start, self.config.device_sample_rate);
        let global_master_bar =
            global_master_beat / f64::from(self.global_master.beats_per_bar.max(1));
        let global_master_bpm = self.global_master.bpm();
        for deck_id in 0..self.decks.len() {
            let Some((
                source_frame,
                position_seconds,
                deck_beat,
                deck_bar,
                loop_start_beat,
                loop_length_beats,
                volume,
                ratio,
                effective_bpm,
                playing,
                synced,
                loop_active,
            )) = ({
                let Some(deck) = self.decks[deck_id].as_mut() else {
                    continue;
                };
                if global_start < deck.next_tick_frame {
                    continue;
                }
                deck.next_tick_frame = global_start.saturating_add(tick_interval_frames);
                let source_frame = deck.source_frame_at(global_start);
                let position_seconds = source_frame / f64::from(deck.track.sample_rate.max(1));
                let deck_beat = deck
                    .track
                    .beat_grid
                    .as_ref()
                    .and_then(|grid| grid.beat_at_time(position_seconds))
                    .unwrap_or(f64::NAN);
                let deck_bar = deck
                    .track
                    .beat_grid
                    .as_ref()
                    .map(|grid| deck_beat / f64::from(grid.beats_per_bar.max(1)))
                    .unwrap_or(f64::NAN);
                let (loop_start_beat, loop_length_beats) = if deck.loop_state.active {
                    deck.track
                        .beat_grid
                        .as_ref()
                        .and_then(|grid| {
                            let start = grid.beat_at_time(deck.loop_state.start_seconds)?;
                            let end = grid.beat_at_time(deck.loop_state.end_seconds)?;
                            Some((start, end - start))
                        })
                        .unwrap_or((f64::NAN, f64::NAN))
                } else {
                    (f64::NAN, 0.0)
                };
                Some((
                    source_frame,
                    position_seconds,
                    deck_beat,
                    deck_bar,
                    loop_start_beat,
                    loop_length_beats,
                    deck.volume(),
                    deck.ratio(),
                    deck.original_bpm() * deck.ratio(),
                    deck.playing,
                    deck.synced_to_master,
                    deck.loop_state.active,
                ))
            })
            else {
                continue;
            };

            let _ = tx.push(Tick {
                deck_id: deck_id as u32,
                global_frame: global_start,
                source_frame,
                position_seconds,
                deck_beat,
                deck_bar,
                global_master_beat,
                global_master_bar,
                global_master_bpm,
                loop_start_beat,
                loop_length_beats,
                volume,
                ratio,
                effective_bpm,
                playing: u8::from(playing),
                synced: u8::from(synced),
                loop_active: u8::from(loop_active),
                phase_diff_samples: self
                    .phase_difference_samples(deck_id, global_start)
                    .unwrap_or_default(),
            });
        }
        self.telemetry_tx = Some(tx);
    }

    fn ensure_slot(&self, deck_id: DeckId) -> Result<(), EngineError> {
        if deck_id < self.decks.len() {
            Ok(())
        } else {
            Err(EngineError::InvalidDeck(deck_id))
        }
    }

    fn require_deck(&self, deck_id: DeckId) -> Result<(), EngineError> {
        self.ensure_slot(deck_id)?;
        if self.decks[deck_id].is_some() {
            Ok(())
        } else {
            Err(EngineError::EmptyDeck(deck_id))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use djengine_core::BeatGrid;

    use super::{Engine, EngineConfig};
    use crate::commands::QuantizeMode;
    use crate::deck::DecodedTrack;

    fn click_track(bpm: f64, seconds: f64) -> DecodedTrack {
        let sample_rate = 48_000;
        let frames = (seconds * f64::from(sample_rate)) as usize;
        let mut samples = vec![0.0; frames * 2];
        let beat = 60.0 / bpm;
        let mut beats = Vec::new();
        let mut t = 0.0;
        while t < seconds {
            beats.push(t as f32);
            let idx = (t * f64::from(sample_rate)) as usize;
            if idx < frames {
                samples[idx * 2] = 1.0;
                samples[idx * 2 + 1] = 1.0;
            }
            t += beat;
        }
        DecodedTrack {
            sample_rate,
            channels: 2,
            samples: Arc::new(samples),
            beat_grid: Some(BeatGrid::new(beats)),
            original_bpm: Some(bpm),
        }
    }

    fn constant_track(seconds: f64) -> DecodedTrack {
        let sample_rate = 48_000;
        let frames = (seconds * f64::from(sample_rate)) as usize;
        DecodedTrack {
            sample_rate,
            channels: 2,
            samples: Arc::new(vec![0.5; frames * 2]),
            beat_grid: Some(BeatGrid::new(
                (0..(seconds * 2.0) as usize)
                    .map(|beat| beat as f32 * 0.5)
                    .collect(),
            )),
            original_bpm: Some(120.0),
        }
    }

    #[test]
    fn offline_engine_advances_clock() {
        let mut engine = Engine::new(EngineConfig::default());
        let deck = engine.load_track(click_track(120.0, 2.0)).unwrap();
        engine
            .handle_command(crate::Command::Play { deck_id: deck })
            .unwrap();
        let mut out = vec![0.0; 512 * 2];
        engine.process_offline(512, &mut out);
        assert_eq!(engine.current_global_frame(), 512);
        assert!(out.iter().any(|sample| *sample != 0.0));
    }

    #[test]
    fn scheduled_stop_applies_on_exact_quantized_frame() {
        let mut engine = Engine::new(EngineConfig::default());
        let deck = engine.load_track(constant_track(2.0)).unwrap();
        engine
            .handle_command(crate::Command::Play { deck_id: deck })
            .unwrap();
        engine
            .handle_command(crate::Command::Schedule {
                quantize: QuantizeMode::Beat,
                offset_beats: 0.0,
                command: Box::new(crate::Command::Stop { deck_id: deck }),
            })
            .unwrap();

        let mut out = vec![0.0; 48_000 * 2];
        engine.process_offline(48_000, &mut out);

        let stop_frame = 24_000;
        assert!(out[..stop_frame * 2]
            .iter()
            .all(|sample| (*sample - 0.5).abs() < 1.0e-6));
        assert!(out[stop_frame * 2..]
            .iter()
            .all(|sample| sample.abs() < 1.0e-6));
        assert!(!engine.deck(deck).unwrap().playing);
        assert_eq!(engine.current_global_frame(), 48_000);
    }
}
