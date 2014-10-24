/**
 * video-js-hls
 *
 * Copyright (c) 2014 Brightcove
 * All rights reserved.
 */

/**
 * A stream-based mp2t to mp4 converter. This utility is used to
 * deliver mp4s to a SourceBuffer on platforms that support native
 * Media Source Extensions. The equivalent process for Flash-based
 * platforms can be found in segment-parser.js
 */
(function(window, videojs, undefined) {
'use strict';

var PacketStream, ParseStream, ProgramStream, Transmuxer, AacStream, H264Stream, NalByteStream, MP2T_PACKET_LENGTH, H264_STREAM_TYPE, ADTS_STREAM_TYPE, mp4;

MP2T_PACKET_LENGTH = 188; // bytes
H264_STREAM_TYPE = 0x1b;
ADTS_STREAM_TYPE = 0x0f;
mp4 = videojs.mp4;

/**
 * Splits an incoming stream of binary data into MP2T packets.
 */
PacketStream = function() {
  var
    buffer = new Uint8Array(MP2T_PACKET_LENGTH),
    end = 0;

  PacketStream.prototype.init.call(this);

  /**
   * Deliver new bytes to the stream.
   */
  this.push = function(bytes) {
    var remaining, i;

    // clear out any partial packets in the buffer
    if (end > 0) {
      remaining = MP2T_PACKET_LENGTH - end;
      buffer.set(bytes.subarray(0, remaining), end);

      // we still didn't write out a complete packet
      if (bytes.byteLength < remaining) {
        end += bytes.byteLength;
        return;
      }

      bytes = bytes.subarray(remaining);
      end = 0;
      this.trigger('data', buffer);
    }

    // if less than a single packet is available, buffer it up for later
    if (bytes.byteLength < MP2T_PACKET_LENGTH) {
      buffer.set(bytes.subarray(i), end);
      end += bytes.byteLength;
      return;
    }
    // parse out all the completed packets
    i = 0;
    do {
      this.trigger('data', bytes.subarray(i, i + MP2T_PACKET_LENGTH));
      i += MP2T_PACKET_LENGTH;
      remaining = bytes.byteLength - i;
    } while (i < bytes.byteLength && remaining >= MP2T_PACKET_LENGTH);
    // buffer any partial packets left over
    if (remaining > 0) {
      buffer.set(bytes.subarray(i));
      end = remaining;
    }
  };
};
PacketStream.prototype = new videojs.Hls.Stream();

/**
 * Accepts an MP2T PacketStream and emits data events with parsed
 * forms of the individual packets.
 */
ParseStream = function() {
  var parsePsi, parsePat, parsePmt, parsePes, self;
  ParseStream.prototype.init.call(this);
  self = this;

  this.programMapTable = {};

  parsePsi = function(payload, psi) {
    var offset = 0;

    // PSI packets may be split into multiple sections and those
    // sections may be split into multiple packets. If a PSI
    // section starts in this packet, the payload_unit_start_indicator
    // will be true and the first byte of the payload will indicate
    // the offset from the current position to the start of the
    // section.
    if (psi.payloadUnitStartIndicator) {
      offset += payload[offset] + 1;
    }

    if (psi.type === 'pat') {
      parsePat(payload.subarray(offset), psi);
    } else {
      parsePmt(payload.subarray(offset), psi);
    }
  };

  parsePat = function(payload, pat) {
    pat.section_number = payload[7];
    pat.last_section_number = payload[8];

    // skip the PSI header and parse the first PMT entry
    self.pmtPid = (payload[10] & 0x1F) << 8 | payload[11];
    pat.pmtPid = self.pmtPid;
  };

  /**
   * Parse out the relevant fields of a Program Map Table (PMT).
   * @param payload {Uint8Array} the PMT-specific portion of an MP2T
   * packet. The first byte in this array should be the table_id
   * field.
   * @param pmt {object} the object that should be decorated with
   * fields parsed from the PMT.
   */
  parsePmt = function(payload, pmt) {
    var sectionLength, tableEnd, programInfoLength, offset;

    // PMTs can be sent ahead of the time when they should actually
    // take effect. We don't believe this should ever be the case
    // for HLS but we'll ignore "forward" PMT declarations if we see
    // them. Future PMT declarations have the current_next_indicator
    // set to zero.
    if (!(payload[5] & 0x01)) {
      return;
    }

    // overwrite any existing program map table
    self.programMapTable = {};

    // the mapping table ends at the end of the current section
    sectionLength = (payload[1] & 0x0f) << 8 | payload[2];
    tableEnd = 3 + sectionLength - 4;

    // to determine where the table is, we have to figure out how
    // long the program info descriptors are
    programInfoLength = (payload[10] & 0x0f) << 8 | payload[11];

    // advance the offset to the first entry in the mapping table
    offset = 12 + programInfoLength;
    while (offset < tableEnd) {
      // add an entry that maps the elementary_pid to the stream_type
      self.programMapTable[(payload[offset + 1] & 0x1F) << 8 | payload[offset + 2]] = payload[offset];

      // move to the next table entry
      // skip past the elementary stream descriptors, if present
      offset += ((payload[offset + 3] & 0x0F) << 8 | payload[offset + 4]) + 5;
    }

    // record the map on the packet as well
    pmt.programMapTable = self.programMapTable;
  };

  parsePes = function(payload, pes) {
    var ptsDtsFlags;

    if (!pes.payloadUnitStartIndicator) {
      pes.data = payload;
      return;
    }

    // find out if this packets starts a new keyframe
    pes.dataAlignmentIndicator = (payload[6] & 0x04) !== 0;
    // PES packets may be annotated with a PTS value, or a PTS value
    // and a DTS value. Determine what combination of values is
    // available to work with.
    ptsDtsFlags = payload[7];

    // PTS and DTS are normally stored as a 33-bit number.  Javascript
    // performs all bitwise operations on 32-bit integers but it's
    // convenient to convert from 90ns to 1ms time scale anyway. So
    // what we are going to do instead is drop the least significant
    // bit (in effect, dividing by two) then we can divide by 45 (45 *
    // 2 = 90) to get ms.
    if (ptsDtsFlags & 0xC0) {
      // the PTS and DTS are not written out directly. For information
      // on how they are encoded, see
      // http://dvd.sourceforge.net/dvdinfo/pes-hdr.html
      pes.pts = (payload[9] & 0x0E) << 28
        | (payload[10] & 0xFF) << 21
        | (payload[11] & 0xFE) << 13
        | (payload[12] & 0xFF) <<  6
        | (payload[13] & 0xFE) >>>  2;
      pes.pts /= 45;
      pes.dts = pes.pts;
      if (ptsDtsFlags & 0x40) {
        pes.dts = (payload[14] & 0x0E ) << 28
          | (payload[15] & 0xFF ) << 21
          | (payload[16] & 0xFE ) << 13
          | (payload[17] & 0xFF ) << 6
          | (payload[18] & 0xFE ) >>> 2;
        pes.dts /= 45;
      }
    }

    // the data section starts immediately after the PES header.
    // pes_header_data_length specifies the number of header bytes
    // that follow the last byte of the field.
    pes.data = payload.subarray(9 + payload[8]);
  };

  /**
   * Deliver a new MP2T packet to the stream.
   */
  this.push = function(packet) {
    var
      result = {},
      offset = 4;
    // make sure packet is aligned on a sync byte
    if (packet[0] !== 0x47) {
      return this.trigger('error', 'mis-aligned packet');
    }
    result.payloadUnitStartIndicator = !!(packet[1] & 0x40);

    // pid is a 13-bit field starting at the last bit of packet[1]
    result.pid = packet[1] & 0x1f;
    result.pid <<= 8;
    result.pid |= packet[2];

    // if an adaption field is present, its length is specified by the
    // fifth byte of the TS packet header. The adaptation field is
    // used to add stuffing to PES packets that don't fill a complete
    // TS packet, and to specify some forms of timing and control data
    // that we do not currently use.
    if (((packet[3] & 0x30) >>> 4) > 0x01) {
      offset += packet[offset] + 1;
    }

    // parse the rest of the packet based on the type
    if (result.pid === 0) {
      result.type = 'pat';
      parsePsi(packet.subarray(offset), result);
    } else if (result.pid === this.pmtPid) {
      result.type = 'pmt';
      parsePsi(packet.subarray(offset), result);
    } else {
      result.streamType = this.programMapTable[result.pid];
      result.type = 'pes';
      parsePes(packet.subarray(offset), result);
    }

    this.trigger('data', result);
  };
};
ParseStream.prototype = new videojs.Hls.Stream();
ParseStream.STREAM_TYPES  = {
  h264: 0x1b,
  adts: 0x0f
};

/**
 * Reconsistutes program stream packets from multiple transport stream packets.
 */
ProgramStream = function() {
  var
    // PES packet fragments
    video = {
      data: [],
      size: 0
    },
    audio = {
      data: [],
      size: 0
    },
    flushStream = function(stream, type) {
      var
        event = {
          type: type,
          data: new Uint8Array(stream.size),
        },
        i = 0,
        fragment;

      // do nothing if there is no buffered data
      if (!stream.data.length) {
        return;
      }
      event.trackId = stream.data[0].pid;

      // reassemble the packet
      while (stream.data.length) {
        fragment = stream.data.shift();

        event.data.set(fragment.data, i);
        i += fragment.data.byteLength;
      }
      stream.size = 0;

      self.trigger('data', event);
    },
    self;

  ProgramStream.prototype.init.call(this);
  self = this;

  this.push = function(data) {
    ({
      pat: function() {
        // we have to wait for the PMT to arrive as well before we
        // have any meaningful metadata
      },
      pes: function() {
        var stream, streamType;

        if (data.streamType === H264_STREAM_TYPE) {
          stream = video;
          streamType = 'video';
        } else {
          stream = audio;
          streamType = 'audio';
        }

        // if a new packet is starting, we can flush the completed
        // packet
        if (data.payloadUnitStartIndicator) {
          flushStream(stream, streamType);
        }

        // buffer this fragment until we are sure we've received the
        // complete payload
        stream.data.push(data);
        stream.size += data.data.byteLength;
      },
      pmt: function() {
        var
          event = {
            type: 'metadata',
            tracks: []
          },
          programMapTable = data.programMapTable,
          k,
          track;

        // translate streams to tracks
        for (k in programMapTable) {
          if (programMapTable.hasOwnProperty(k)) {
            track = {};
            track.id = +k;
            if (programMapTable[k] === H264_STREAM_TYPE) {
              track.codec = 'avc';
              track.type = 'video';
            } else if (programMapTable[k] === ADTS_STREAM_TYPE) {
              track.codec = 'adts';
              track.type = 'audio';
            }
            event.tracks.push(track);
          }
        }
        self.trigger('data', event);
      }
    })[data.type]();
  };

  /**
   * Flush any remaining input. Video PES packets may be of variable
   * length. Normally, the start of a new video packet can trigger the
   * finalization of the previous packet. That is not possible if no
   * more video is forthcoming, however. In that case, some other
   * mechanism (like the end of the file) has to be employed. When it is
   * clear that no additional data is forthcoming, calling this method
   * will flush the buffered packets.
   */
  this.end = function() {
    flushStream(video, 'video');
    flushStream(audio, 'audio');
  };
};
ProgramStream.prototype = new videojs.Hls.Stream();

/*
 * Accepts a ProgramStream and emits data events with parsed
 * AAC Audio Frames of the individual packets.
 */
AacStream = function() {
  var  self;
  AacStream.prototype.init.call(this);
  self = this;

  this.push = function(packet) {
    if (packet.type === 'audio') {
      this.trigger('data', packet);
    }
  };
};
AacStream.prototype = new videojs.Hls.Stream();

/**
 * Accepts a NAL unit byte stream and unpacks the embedded NAL units.
 */
NalByteStream = function() {
  var
    i = 6,
    // the first NAL unit is prefixed by an extra zero byte
    syncPoint = 1,
    buffer;
  NalByteStream.prototype.init.call(this);

  this.push = function(data) {
    var swapBuffer;

    if (!buffer) {
      buffer = data.data;
    } else {
      swapBuffer = new Uint8Array(buffer.byteLength + data.data.byteLength);
      swapBuffer.set(buffer);
      swapBuffer.set(data.data, buffer.byteLength);
      buffer = swapBuffer;
    }

    // scan for synchronization byte sequences (0x00 00 01)

    // a match looks like this:
    // 0 0 1 .. NAL .. 0 0 1
    // ^ sync point        ^ i
    while (i < buffer.byteLength) {
      switch (buffer[i]) {
      case 0:
        i++;
        break;
      case 1:
        // skip past non-sync sequences
        if (buffer[i - 1] !== 0 ||
            buffer[i - 2] !== 0) {
          i += 3;
          break;
        }

        // deliver the NAL unit
        this.trigger('data', buffer.subarray(syncPoint + 3, i - 2));
        syncPoint = i - 2;
        i += 3;
        break;
      default:
        i += 3;
        break;
      }
    }
    // filter out the NAL units that were delivered
    buffer = buffer.subarray(syncPoint);
    i -= syncPoint;
    syncPoint = 0;
  };

  this.end = function() {
    // deliver the last buffered NAL unit
    if (buffer.byteLength > 3) {
      this.trigger('data', buffer.subarray(syncPoint + 3));
    }
  };
};
NalByteStream.prototype = new videojs.Hls.Stream();

/**
 * Accepts a ProgramStream and emits data events with parsed
 * AAC Audio Frames of the individual packets.
 */
H264Stream = function() {
  var
    nalByteStream = new NalByteStream(),
    self,
    trackId,

    readSequenceParameterSet,
    skipScalingList;

  H264Stream.prototype.init.call(this);
  self = this;

  this.push = function(packet) {
    if (packet.type !== 'video') {
      return;
    }
    trackId = packet.trackId;

    nalByteStream.push(packet);
  };

  nalByteStream.on('data', function(data) {
    var event = {
      trackId: trackId,
      data: data
    };
    switch (data[0] & 0x1f) {
    case 0x09:
      event.nalUnitType = 'access_unit_delimiter_rbsp';
      break;

    case 0x07:
      event.nalUnitType = 'seq_parameter_set_rbsp';
      event.config = readSequenceParameterSet(data.subarray(1));
      break;
    case 0x08:
      event.nalUnitType = 'pic_parameter_set_rbsp';
      break;

    default:
      break;
    }
    self.trigger('data', event);
  });

  this.end = function() {
    nalByteStream.end();
  };

  /**
   * Advance the ExpGolomb decoder past a scaling list. The scaling
   * list is optionally transmitted as part of a sequence parameter
   * set and is not relevant to transmuxing.
   * @param count {number} the number of entries in this scaling list
   * @param expGolombDecoder {object} an ExpGolomb pointed to the
   * start of a scaling list
   * @see Recommendation ITU-T H.264, Section 7.3.2.1.1.1
   */
  skipScalingList = function(count, expGolombDecoder) {
    var
      lastScale = 8,
      nextScale = 8,
      j,
      deltaScale;

    for (j = 0; j < count; j++) {
      if (nextScale !== 0) {
        deltaScale = expGolombDecoder.readExpGolomb();
        nextScale = (lastScale + deltaScale + 256) % 256;
      }

      lastScale = (nextScale === 0) ? lastScale : nextScale;
    }
  };

  /**
   * Read a sequence parameter set and return some interesting video
   * properties. A sequence parameter set is the H264 metadata that
   * describes the properties of upcoming video frames.
   * @param data {Uint8Array} the bytes of a sequence parameter set
   * @return {object} an object with configuration parsed from the
   * sequence parameter set, including the dimensions of the
   * associated video frames.
   */
  readSequenceParameterSet = function(data) {
    var
      frameCropLeftOffset = 0,
      frameCropRightOffset = 0,
      frameCropTopOffset = 0,
      frameCropBottomOffset = 0,
      expGolombDecoder, profileIdc, levelIdc, profileCompatibility,
      chromaFormatIdc, picOrderCntType,
      numRefFramesInPicOrderCntCycle, picWidthInMbsMinus1,
      picHeightInMapUnitsMinus1,
      frameMbsOnlyFlag,
      scalingListCount,
      i;

    expGolombDecoder = new videojs.Hls.ExpGolomb(data);
    profileIdc = expGolombDecoder.readUnsignedByte(); // profile_idc
    profileCompatibility = expGolombDecoder.readBits(5); // constraint_set[0-5]_flag
    expGolombDecoder.skipBits(3); //  u(1), reserved_zero_2bits u(2)
    levelIdc = expGolombDecoder.readUnsignedByte(); // level_idc u(8)
    expGolombDecoder.skipUnsignedExpGolomb(); // seq_parameter_set_id

    // some profiles have more optional data we don't need
    if (profileIdc === 100 ||
        profileIdc === 110 ||
        profileIdc === 122 ||
        profileIdc === 244 ||
        profileIdc === 44 ||
        profileIdc === 83 ||
        profileIdc === 86 ||
        profileIdc === 118 ||
        profileIdc === 128) {
      chromaFormatIdc = expGolombDecoder.readUnsignedExpGolomb();
      if (chromaFormatIdc === 3) {
        expGolombDecoder.skipBits(1); // separate_colour_plane_flag
      }
      expGolombDecoder.skipUnsignedExpGolomb(); // bit_depth_luma_minus8
      expGolombDecoder.skipUnsignedExpGolomb(); // bit_depth_chroma_minus8
      expGolombDecoder.skipBits(1); // qpprime_y_zero_transform_bypass_flag
      if (expGolombDecoder.readBoolean()) { // seq_scaling_matrix_present_flag
        scalingListCount = (chromaFormatIdc !== 3) ? 8 : 12;
        for (i = 0; i < scalingListCount; i++) {
          if (expGolombDecoder.readBoolean()) { // seq_scaling_list_present_flag[ i ]
            if (i < 6) {
              skipScalingList(16, expGolombDecoder);
            } else {
              skipScalingList(64, expGolombDecoder);
            }
          }
        }
      }
    }

    expGolombDecoder.skipUnsignedExpGolomb(); // log2_max_frame_num_minus4
    picOrderCntType = expGolombDecoder.readUnsignedExpGolomb();

    if (picOrderCntType === 0) {
      expGolombDecoder.readUnsignedExpGolomb(); //log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      expGolombDecoder.skipBits(1); // delta_pic_order_always_zero_flag
      expGolombDecoder.skipExpGolomb(); // offset_for_non_ref_pic
      expGolombDecoder.skipExpGolomb(); // offset_for_top_to_bottom_field
      numRefFramesInPicOrderCntCycle = expGolombDecoder.readUnsignedExpGolomb();
      for(i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
        expGolombDecoder.skipExpGolomb(); // offset_for_ref_frame[ i ]
      }
    }

    expGolombDecoder.skipUnsignedExpGolomb(); // max_num_ref_frames
    expGolombDecoder.skipBits(1); // gaps_in_frame_num_value_allowed_flag

    picWidthInMbsMinus1 = expGolombDecoder.readUnsignedExpGolomb();
    picHeightInMapUnitsMinus1 = expGolombDecoder.readUnsignedExpGolomb();

    frameMbsOnlyFlag = expGolombDecoder.readBits(1);
    if (frameMbsOnlyFlag === 0) {
      expGolombDecoder.skipBits(1); // mb_adaptive_frame_field_flag
    }

    expGolombDecoder.skipBits(1); // direct_8x8_inference_flag
    if (expGolombDecoder.readBoolean()) { // frame_cropping_flag
      frameCropLeftOffset = expGolombDecoder.readUnsignedExpGolomb();
      frameCropRightOffset = expGolombDecoder.readUnsignedExpGolomb();
      frameCropTopOffset = expGolombDecoder.readUnsignedExpGolomb();
      frameCropBottomOffset = expGolombDecoder.readUnsignedExpGolomb();
    }

    return {
      profileIdc: profileIdc,
      levelIdc: levelIdc,
      profileCompatibility: profileCompatibility,
      width: ((picWidthInMbsMinus1 + 1) * 16) - frameCropLeftOffset * 2 - frameCropRightOffset * 2,
      height: ((2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16) - (frameCropTopOffset * 2) - (frameCropBottomOffset * 2)
    };
  };

};
H264Stream.prototype = new videojs.Hls.Stream();


Transmuxer = function() {
  var
    self = this,
    sequenceNumber = 0,
    videoSamples = [],
    videoSamplesSize = 0,
    tracks,
    config,
    pps,

    packetStream, parseStream, programStream, aacStream, h264Stream,

    flushVideo;

  Transmuxer.prototype.init.call(this);

  // set up the parsing pipeline
  packetStream = new PacketStream();
  parseStream = new ParseStream();
  programStream = new ProgramStream();
  aacStream = new AacStream();
  h264Stream = new H264Stream();

  packetStream.pipe(parseStream);
  parseStream.pipe(programStream);
  programStream.pipe(aacStream);
  programStream.pipe(h264Stream);

  // handle incoming data events
  h264Stream.on('data', function(data) {
    var i;

    // if this chunk starts a new access unit, flush the data we've been buffering
    if (data.nalUnitType === 'access_unit_delimiter_rbsp' &&
        videoSamples.length) {
      //flushVideo();
    }
    // record the track config
    if (data.nalUnitType === 'seq_parameter_set_rbsp' &&
        !config) {
      config = data.config;

      i = tracks.length;
      while (i--) {
        if (tracks[i].type === 'video') {
          tracks[i].width = config.width;
          tracks[i].height = config.height;
          tracks[i].sps = [data.data];
          tracks[i].profileIdc = config.profileIdc;
          tracks[i].levelIdc = config.levelIdc;
          tracks[i].profileCompatibility = config.profileCompatibility;
        }
      }
      // generate an init segment once all the metadata is available
      if (pps) {
        self.trigger('data', {
          data: videojs.mp4.initSegment(tracks)
        });
      }
    }
    if (data.nalUnitType === 'pic_parameter_set_rbsp' &&
        !pps) {
      pps = data.data;i = tracks.length;

      while (i--) {
        if (tracks[i].type === 'video') {
          tracks[i].pps = [data.data];
        }
      }
      if (config) {
        self.trigger('data', {
          data: videojs.mp4.initSegment(tracks)
        });
      }
    }

    // buffer video until we encounter a new access unit (aka the next frame)
    videoSamples.push(data);
    videoSamplesSize += data.data.byteLength;
  });
  programStream.on('data', function(data) {
    if (data.type === 'metadata') {
      tracks = data.tracks;
    }
  });

  // helper functions
  flushVideo = function() {
    var moof, mdat, boxes, i, data;

    moof = mp4.moof(sequenceNumber, []);

    // concatenate the video data and construct the mdat
    data = new Uint8Array(videoSamplesSize);
    i = 0;
    while (videoSamples.length) {
      data.set(videoSamples[0].data, i);
      i += videoSamples[0].data.byteLength;
      videoSamples.shift();
    }
    videoSamplesSize = 0;
    mdat = mp4.mdat(data);

    // it would be great to allocate this array up front instead of
    // throwing away hundreds of media segment fragments
    boxes = new Uint8Array(moof.byteLength + mdat.byteLength);

    // bump the sequence number for next time
    sequenceNumber++;

    boxes.set(moof);
    boxes.set(mdat, moof.byteLength);

    self.trigger('data', {
      data: boxes
    });
  };

  // feed incoming data to the front of the parsing pipeline
  this.push = function(data) {
    packetStream.push(data);
  };
  // flush any buffered data
  this.end = function() {
    programStream.end();
    h264Stream.end();
    if (videoSamples.length) {
      flushVideo();
    }
  };
};
Transmuxer.prototype = new videojs.Hls.Stream();

window.videojs.mp2t = {
  PAT_PID: 0x0000,
  MP2T_PACKET_LENGTH: MP2T_PACKET_LENGTH,
  H264_STREAM_TYPE: H264_STREAM_TYPE,
  ADTS_STREAM_TYPE: ADTS_STREAM_TYPE,
  PacketStream: PacketStream,
  ParseStream: ParseStream,
  ProgramStream: ProgramStream,
  Transmuxer: Transmuxer,
  AacStream: AacStream,
  H264Stream: H264Stream
};
})(window, window.videojs);
